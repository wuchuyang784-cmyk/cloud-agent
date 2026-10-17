export type AnnouncementStatus = 'draft' | 'scheduled' | 'published' | 'withdrawn' | 'expired';
export type Announcement = { id: string; title: string; body?: string; severity: 'normal' | 'important'; pinned: boolean;
  status: AnnouncementStatus; version: number; createdAt: string; updatedAt: string; createdBy?: string; updatedBy?: string;
  expiryDays: number | null; expiresAt: string | null; scheduledAt: string | null; publishedAt: string | null; withdrawalReason?: string | null;
  publishBlocked?: boolean; lastPublishError?: string | null; publishAttempts?: number; nextPublishAttemptAt?: string | null };
export type AnnouncementDraft = { title: string; body: string; severity: 'normal' | 'important'; pinned: boolean;
  expiryMode: 'default' | 'forever' | 'at'; expiresLocal: string };
export type AnnouncementAudit = { id: string; action: string; actorUserId: string | null; version: number; previousVersion: number;
  occurredAt: string; reason: string | null; contentHash: string; changedFields: string[]; executorType?: 'admin' | 'system';
  executorId?: string | null; scheduleGovernanceVersion?: number | null };
type Confirmation = 'publish' | 'schedule' | 'cancel-schedule' | 'withdraw';
type Identity = { role: string; permissions: string[]; user: { id: string; email: string } };
type Transport = (path: string, init?: RequestInit) => Promise<Response>;
type Query = { q: string; status: string; after: string; limit: number };
type Pending = { path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown> };
export type AnnouncementSnapshot = { phase: 'idle' | 'loading' | 'ready' | 'error'; canManage: boolean; items: Announcement[];
  query: Query; history: string[]; nextCursor: string | null; selected: Announcement | null; draft: AnnouncementDraft | null; dirty: boolean;
  detailLoading: boolean; busy: boolean; pending: Pending | null; confirmation: Confirmation | null; needsReload: boolean;
  error: string; success: string; audit: { items: AnnouncementAudit[]; nextCursor: string | null; busy: boolean; error: string } };

const initial = (): AnnouncementSnapshot => ({ phase: 'idle', canManage: false, items: [], query: { q: '', status: '', after: '', limit: 25 }, history: [], nextCursor: null,
  selected: null, draft: null, dirty: false, detailLoading: false, busy: false, pending: null, confirmation: null, needsReload: false, error: '', success: '',
  audit: { items: [], nextCursor: null, busy: false, error: '' } });
export const announcementLabels: Record<AnnouncementStatus, string> = { draft: '草稿', scheduled: '待发布', published: '已发布', withdrawn: '已撤回', expired: '已过期' };
export function announcementStateLabel(item: Announcement, now = Date.now()) {
  return item.status !== 'scheduled' ? announcementLabels[item.status] : item.publishBlocked ? '发布阻塞'
    : item.scheduledAt && Date.parse(item.scheduledAt) <= now ? '待发布（已到计划时间）' : '待发布';
}
export const announcementDate = (value: string | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
export function shanghaiTime(local: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(local)) return null;
  const normalized = local.length === 16 ? local + ':00.000' : local.length === 19 ? local + '.000' : local.padEnd(23, '0');
  const date = new Date(normalized + '+08:00');
  if (!Number.isFinite(date.valueOf()) || new Date(date.valueOf() + 8 * 3600000).toISOString().slice(0, -1) !== normalized) return null;
  return date.toISOString();
}
export function draftError(draft: AnnouncementDraft) {
  if (!draft.title.trim() || [...draft.title].length > 120 || /[\x00-\x1f\x7f]/.test(draft.title)) return '标题必填，最多 120 个字符，不能包含换行或控制字符。';
  if (!draft.body.trim() || [...draft.body].length > 20000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(draft.body)) return '正文必填，最多 20000 个字符，仅支持纯文本与换行。';
  if (draft.expiryMode === 'at' && (!shanghaiTime(draft.expiresLocal) || Date.parse(shanghaiTime(draft.expiresLocal)!) <= Date.now())) return '请填写未来的有效截止时间（Asia/Shanghai）。';
  return '';
}
function draftOf(item?: Announcement, copy = false): AnnouncementDraft {
  return { title: item?.title ?? '', body: item?.body ?? '', severity: item?.severity ?? 'normal', pinned: item?.pinned ?? false,
    expiryMode: copy || !item || item.expiryDays === 30 ? 'default' : item.expiresAt === null ? 'forever' : 'at',
    expiresLocal: !copy && item?.expiresAt ? new Date(Date.parse(item.expiresAt) + 8 * 3600000).toISOString().slice(0, -1) : '' };
}
const validItem = (value: Announcement, body = false) => value && typeof value.id === 'string' && typeof value.title === 'string'
  && value.status in announcementLabels && Number.isInteger(value.version) && (!body || typeof value.body === 'string');
class HttpError extends Error { status: number; code: string; constructor(status: number, code = '') { super('request_failed'); this.status = status; this.code = code; } }

export class AnnouncementSession {
  private state = initial();
  private identity: Identity | null = null;
  private listeners = new Set<() => void>();
  private generation = 0;
  private listGeneration = 0;
  private detailGeneration = 0;
  private root = new AbortController();
  private transports = new Map<string, AbortController>();
  private transport: Transport;
  private timeoutMs: number;
  private onDenied: (status: number) => void;
  constructor(transport: Transport = (path, init) => fetch(path, init), options: { timeoutMs?: number; onDenied?: (status: number) => void } = {}) {
    this.transport = transport; this.timeoutMs = options.timeoutMs ?? 15000; this.onDenied = options.onDenied ?? (() => {});
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: Partial<AnnouncementSnapshot>) { this.state = { ...this.state, ...next }; this.listeners.forEach(listener => listener()); }
  reset = () => {
    this.generation++; this.listGeneration++; this.detailGeneration++; this.root.abort(); this.root = new AbortController();
    this.transports.forEach(controller => controller.abort()); this.transports.clear(); this.identity = null; this.state = initial(); this.listeners.forEach(listener => listener());
  };
  private denied(error: unknown, generation: number) {
    if (generation !== this.generation) return true;
    if (error instanceof HttpError && [401, 403].includes(error.status)) { this.reset(); this.onDenied(error.status); return true; }
    return false;
  }
  private async json(path: string, channel: string, pending?: Pending) {
    this.transports.get(channel)?.abort();
    const controller = new AbortController(); this.transports.set(channel, controller);
    const signal = AbortSignal.any([this.root.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([
        (async () => {
          const result = await this.transport(path, { signal, credentials: 'same-origin', cache: 'no-store',
            ...(pending ? { method: pending.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(pending.body) } : {}) });
          if (!result.ok) { const value = await result.json().catch(() => ({})); throw new HttpError(result.status, value.error?.code || ''); }
          return result.json();
        })(),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('request_cancelled')); signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => { reject(new Error('request_timeout')); controller.abort(); }, this.timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); if (this.transports.get(channel) === controller) this.transports.delete(channel); }
  }
  activate = async (identity: Identity) => {
    if (!identity.user?.id || !['platform_admin', 'platform_operator', 'platform_viewer'].includes(identity.role) || !identity.permissions.includes('announcements:read')) {
      this.reset(); this.onDenied(403); return;
    }
    const changed = this.identity && (this.identity.user.id !== identity.user.id || this.identity.role !== identity.role
      || [...this.identity.permissions].sort().join() !== [...identity.permissions].sort().join());
    if (changed) this.reset();
    this.identity = identity;
    this.publish({ canManage: identity.role === 'platform_admin' && identity.permissions.includes('announcements:manage') });
    if (!this.state.draft && !this.state.selected && !this.state.busy) await this.load();
  };
  load = async (query: Partial<Query> = {}) => {
    if (!this.identity) return;
    const generation = this.generation, list = ++this.listGeneration, next = { ...this.state.query, ...query };
    this.publish({ phase: 'loading', items: [], nextCursor: null, query: next });
    const params = new URLSearchParams({ limit: String(next.limit) });
    for (const key of ['q', 'status', 'after'] as const) if (next[key]) params.set(key, next[key]);
    try {
      const result = await this.json('/api/admin/announcements?' + params, 'list');
      if (generation !== this.generation || list !== this.listGeneration) return;
      if (!Array.isArray(result.items) || result.items.length > next.limit || !result.items.every((row: Announcement) => validItem(row))
        || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new Error('invalid_page');
      this.publish({ phase: 'ready', items: result.items, nextCursor: result.nextCursor, error: '' });
    } catch (error) {
      if (list !== this.listGeneration || this.denied(error, generation)) return;
      this.publish({ phase: 'error', items: [], nextCursor: null, error: '公告列表暂不可用，请重试。' });
    }
  };
  filter = async (query: Partial<Query>) => { if (this.state.busy) return; this.publish({ history: [] }); await this.load({ ...query, after: '' }); };
  next = async () => { if (!this.state.nextCursor || this.state.phase !== 'ready') return; this.publish({ history: [...this.state.history, this.state.query.after] }); await this.load({ after: this.state.nextCursor }); };
  back = async () => { if (!this.state.history.length || this.state.phase !== 'ready') return; const history = this.state.history.slice(); const after = history.pop()!; this.publish({ history }); await this.load({ after }); };
  newDraft = (copy?: Announcement) => {
    if (!this.state.canManage || this.state.busy || this.state.pending || (copy && this.state.dirty)) return;
    this.detailGeneration++; this.publish({ selected: null, draft: draftOf(copy, true), dirty: true, confirmation: null, needsReload: false, error: '', success: '', detailLoading: false,
      audit: { items: [], nextCursor: null, busy: false, error: '' } });
  };
  updateDraft = (patch: Partial<AnnouncementDraft>) => {
    if (!this.state.canManage || !this.state.draft || this.state.busy || this.state.pending || this.state.needsReload
      || (this.state.selected && this.state.selected.status !== 'draft')) return;
    this.publish({ draft: { ...this.state.draft, ...patch }, dirty: true, confirmation: null, success: '' });
  };
  close = () => {
    if (this.state.busy || this.state.pending) return;
    this.detailGeneration++; this.transports.get('detail')?.abort(); this.transports.get('audit')?.abort();
    this.publish({ selected: null, draft: null, dirty: false, confirmation: null, needsReload: false, detailLoading: false, error: '', success: '', audit: { items: [], nextCursor: null, busy: false, error: '' } });
  };
  open = async (id: string) => {
    if (!this.identity || this.state.busy || this.state.pending) return;
    const generation = this.generation, detail = ++this.detailGeneration;
    this.publish({ selected: null, draft: null, dirty: false, confirmation: null, needsReload: false, detailLoading: true, error: '', success: '', audit: { items: [], nextCursor: null, busy: false, error: '' } });
    try {
      const result = await this.json('/api/admin/announcements/' + encodeURIComponent(id), 'detail');
      if (generation !== this.generation || detail !== this.detailGeneration) return;
      if (!validItem(result.announcement, true)) throw new Error('invalid_detail');
      const item = result.announcement as Announcement;
      this.publish({ selected: item, draft: item.status === 'draft' && this.state.canManage ? draftOf(item) : null, detailLoading: false });
      await this.audit();
    } catch (error) {
      if (detail !== this.detailGeneration || this.denied(error, generation)) return;
      this.publish({ detailLoading: false, error: '公告详情读取失败，请重新选择。' });
    }
  };
  audit = async (after = '') => {
    if (!this.state.selected || !this.identity?.permissions.includes('announcement-audit:read')) return;
    const generation = this.generation, detail = this.detailGeneration, id = this.state.selected.id;
    this.publish({ audit: { ...this.state.audit, busy: true, error: '' } });
    try {
      const result = await this.json('/api/admin/announcements/' + encodeURIComponent(id) + '/audit' + (after ? '?after=' + encodeURIComponent(after) : ''), 'audit');
      if (generation !== this.generation || detail !== this.detailGeneration) return;
      if (!Array.isArray(result.items) || result.items.length > 25 || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new Error('invalid_audit');
      this.publish({ audit: { items: after ? [...this.state.audit.items, ...result.items] : result.items, nextCursor: result.nextCursor, busy: false, error: '' } });
    } catch (error) {
      if (detail !== this.detailGeneration || this.denied(error, generation)) return;
      this.publish({ audit: { ...this.state.audit, busy: false, error: '操作记录刷新失败，可重新读取；已确认的操作无需重复提交。' } });
    }
  };
  confirm = (action: Confirmation) => {
    if (!this.state.canManage || this.state.busy || this.state.pending || this.state.needsReload || !this.state.selected || this.state.dirty) return;
    if (this.state.selected.status !== (['publish', 'schedule'].includes(action) ? 'draft' : action === 'cancel-schedule' ? 'scheduled' : 'published')) return;
    this.publish({ confirmation: action, error: '', success: '' });
  };
  cancelConfirmation = () => { if (!this.state.busy && !this.state.pending) this.publish({ confirmation: null }); };
  save = async () => {
    if (!this.state.canManage || !this.state.draft || this.state.busy || this.state.pending || this.state.needsReload) return;
    const draft = this.state.draft, error = draftError(draft);
    if (error) { this.publish({ error }); return; }
    const id = this.state.selected?.id;
    const body: Record<string, unknown> = { title: draft.title.trim(), body: draft.body.trim(), severity: draft.severity, pinned: draft.pinned, requestId: crypto.randomUUID(),
      ...(id ? { expectedVersion: this.state.selected!.version } : {}) };
    if (draft.expiryMode === 'default') body.expiryDays = 30;
    else body.expiresAt = draft.expiryMode === 'forever' ? null : shanghaiTime(draft.expiresLocal);
    await this.send({ path: '/api/admin/announcements' + (id ? '/' + encodeURIComponent(id) : ''), method: id ? 'PATCH' : 'POST', body });
  };
  submit = async (reason = '') => {
    if (!this.state.canManage || !this.state.confirmation || !this.state.selected || this.state.busy || this.state.pending || this.state.needsReload || this.state.dirty) return;
    if (this.state.confirmation === 'withdraw' && (!reason.trim() || [...reason].length > 500 || /[\x00-\x1f\x7f]/.test(reason))) { this.publish({ error: '撤回原因必填，最多 500 个字符，不能包含控制字符。' }); return; }
    if (this.state.confirmation === 'schedule') return;
    await this.send({ path: '/api/admin/announcements/' + encodeURIComponent(this.state.selected.id) + '/' + this.state.confirmation, method: 'POST',
      body: { expectedVersion: this.state.selected.version, requestId: crypto.randomUUID(), ...(this.state.confirmation === 'withdraw' ? { reason: reason.trim() } : {}) } });
  };
  schedule = async (local: string) => {
    if (!this.state.canManage || this.state.confirmation !== 'schedule' || this.state.selected?.status !== 'draft'
      || this.state.busy || this.state.pending || this.state.needsReload || this.state.dirty) return;
    const scheduledAt = shanghaiTime(local);
    if (!scheduledAt || Date.parse(scheduledAt) <= Date.now()) { this.publish({ error: '请选择未来的计划发布时间（Asia/Shanghai）。' }); return; }
    if (this.state.selected.expiryDays === null && this.state.selected.expiresAt && Date.parse(this.state.selected.expiresAt) <= Date.parse(scheduledAt)) {
      this.publish({ error: '计划发布时间必须早于有效截止时间，请返回修改草稿。' }); return;
    }
    await this.send({ path: '/api/admin/announcements/' + encodeURIComponent(this.state.selected.id) + '/publish', method: 'POST',
      body: { mode: 'schedule', scheduledAt, expectedVersion: this.state.selected.version, requestId: crypto.randomUUID() } });
  };
  retry = async () => { if (this.state.canManage && this.state.pending && !this.state.busy) await this.send(this.state.pending); };
  private async send(command: Pending) {
    const generation = this.generation, detail = this.detailGeneration;
    this.publish({ busy: true, pending: command, error: '', success: '' });
    try {
      const result = await this.json(command.path, 'mutation', command);
      if (generation !== this.generation || detail !== this.detailGeneration) return;
      if (!validItem(result.announcement, true)) throw new Error('invalid_mutation_response');
      const item = result.announcement as Announcement;
      this.publish({ selected: item, draft: item.status === 'draft' ? draftOf(item) : null, dirty: false, pending: null, busy: false, confirmation: null, needsReload: false,
        success: item.status === 'scheduled' ? '定时计划已保存并记录审计，尚未发布；实际生效取决于发布器。' : command.path.endsWith('/cancel-schedule') ? '定时已取消并退回草稿，可编辑后重新确认。' : '操作已确认并记录审计。' });
      await this.audit();
    } catch (error) {
      if (detail !== this.detailGeneration || this.denied(error, generation)) return;
      const rejected = error instanceof HttpError && [400, 404, 409, 413, 415, 422].includes(error.status);
      this.publish({ busy: false, pending: rejected ? null : command, confirmation: null, needsReload: rejected && Boolean(this.state.selected) && error instanceof HttpError && [404, 409].includes(error.status),
        error: rejected ? error instanceof HttpError && error.status === 409 ? '公告已变更或请求冲突。请重新读取最新版本后确认，未覆盖其他人的修改。' : '操作被拒绝，请核对内容或重新读取后再提交。'
          : '尚未确认操作结果，请重试原请求；请求号与内容将保持不变。' });
    }
  }
}
