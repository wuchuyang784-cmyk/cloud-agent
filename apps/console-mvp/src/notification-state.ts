export type NotificationItem = {
  id: string; source: 'notification' | 'announcement'; referenceId: string; type: string; title: string; body: string;
  isRead: boolean; readAt: string | null; createdAt: string; pinned: boolean; severity: 'normal' | 'important';
  status: string; expiresAt: string | null;
};
type Query = { source: 'all' | 'notification' | 'announcement'; read: 'all' | 'unread' | 'read'; history: boolean; limit: number; after: string };
type Identity = { userId: string; organizationId: string; accountStatus?: string };
type Command = { path: string; method: 'POST' | 'PATCH'; body: string; item?: NotificationItem };
type Transport = (path: string, init: RequestInit) => Promise<unknown>;
export type NotificationSnapshot = {
  identityKey: string; phase: 'idle' | 'loading' | 'ready' | 'error'; items: NotificationItem[]; unreadCount: number | null;
  updatedAt: number | null; refreshing: boolean; query: Query; history: string[]; nextCursor: string | null;
  canWrite: boolean; busy: boolean; pending: Command | null; error: string; success: string;
  detail: { phase: 'idle' | 'loading' | 'ready' | 'error' | 'missing'; item: NotificationItem | null; error: string };
};
const initial = (): NotificationSnapshot => ({ identityKey: '', phase: 'idle', items: [], unreadCount: null, updatedAt: null, refreshing: false,
  query: { source: 'all', read: 'all', history: false, limit: 25, after: '' }, history: [], nextCursor: null, canWrite: false,
  busy: false, pending: null, error: '', success: '', detail: { phase: 'idle', item: null, error: '' } });
const countIsValid = (count: unknown): count is number => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
const itemIsValid = (item: NotificationItem) => item && ['notification', 'announcement'].includes(item.source)
  && typeof item.id === 'string' && typeof item.referenceId === 'string' && typeof item.title === 'string' && typeof item.body === 'string'
  && typeof item.isRead === 'boolean' && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt));
const statusOf = (error: unknown) => error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
const codeOf = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : '';

export class NotificationSession {
  private state = initial();
  private listeners = new Set<() => void>();
  private generation = 0;
  private listGeneration = 0;
  private detailGeneration = 0;
  private countGeneration = 0;
  private root = new AbortController();
  private channels = new Map<string, AbortController>();
  private reading: Promise<void> | null = null;
  private transport: Transport;
  private timeoutMs: number;
  private onDenied: (status: number, code: string) => void;
  constructor(transport: Transport, options: { timeoutMs?: number; onDenied?: (status: number, code: string) => void } = {}) {
    this.transport = transport; this.timeoutMs = options.timeoutMs ?? 15000; this.onDenied = options.onDenied ?? (() => {});
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: Partial<NotificationSnapshot>) { this.state = { ...this.state, ...value }; this.listeners.forEach(listener => listener()); }
  reset = () => {
    this.generation++; this.listGeneration++; this.detailGeneration++; this.countGeneration++; this.root.abort(); this.root = new AbortController();
    this.channels.forEach(controller => controller.abort()); this.channels.clear(); this.reading = null;
    this.state = initial(); this.listeners.forEach(listener => listener());
  };
  private denied(error: unknown, generation: number) {
    if (generation !== this.generation) return true;
    const status = statusOf(error), code = codeOf(error);
    if (status === 403 && ['account_suspended', 'account_read_only'].includes(code)) {
      this.publish({ canWrite: false, busy: false, pending: null, error: '账号服务已暂停，通知仍可查看，暂不能标记已读。' });
      this.onDenied(status, code); return true;
    }
    if ([401, 403].includes(status)) { this.reset(); this.onDenied(status, code); return true; }
    return false;
  }
  private async request(path: string, channel: string, command?: Command) {
    this.channels.get(channel)?.abort();
    const controller = new AbortController(); this.channels.set(channel, controller);
    const signal = AbortSignal.any([this.root.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined, onAbort = () => {};
    try {
      signal.throwIfAborted();
      return await Promise.race([
        this.transport(path, { signal, cache: 'no-store', credentials: 'same-origin',
          ...(command ? { method: command.method, headers: { 'content-type': 'application/json' }, body: command.body } : {}) }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error('cancelled'));
          signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => { reject(new Error('timeout')); controller.abort(); }, this.timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); if (this.channels.get(channel) === controller) this.channels.delete(channel); }
  }
  activate = async (identity: Identity) => {
    if (!identity.userId || !identity.organizationId) { this.reset(); return; }
    const key = identity.organizationId + ':' + identity.userId;
    if (this.state.identityKey !== key) this.reset();
    this.publish({ identityKey: key, canWrite: !identity.accountStatus || identity.accountStatus === 'active' });
    if (this.state.phase === 'idle') await this.refresh();
  };
  private cancelList() { this.listGeneration++; this.channels.get('list')?.abort(); this.reading = null; }
  private countPatch(token: number, unreadCount: number | null): Partial<NotificationSnapshot> {
    return token === this.countGeneration ? { unreadCount } : {};
  }
  refresh = (): Promise<void> => {
    if (!this.state.identityKey || this.state.busy || this.state.pending) return Promise.resolve();
    if (this.reading) return this.reading;
    const generation = this.generation, list = ++this.listGeneration, query = this.state.query;
    const countToken = ++this.countGeneration;
    const params = new URLSearchParams({ source: query.source, read: query.read, history: String(query.history), limit: String(query.limit) });
    if (query.after) params.set('after', query.after);
    this.publish({ refreshing: true, phase: this.state.items.length ? this.state.phase : 'loading', error: '' });
    const reading = (async () => {
      try {
        const result = await this.request('/api/user/notifications?' + params, 'list') as { notifications: NotificationItem[]; unreadCount: number; nextCursor: string | null };
        if (generation !== this.generation || list !== this.listGeneration) return;
        if (!result || !Array.isArray(result.notifications) || result.notifications.length > query.limit || !result.notifications.every(itemIsValid)
          || !countIsValid(result.unreadCount) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new Error('invalid_page');
        this.publish({ phase: 'ready', items: result.notifications, ...this.countPatch(countToken, result.unreadCount), nextCursor: result.nextCursor, updatedAt: Date.now(), error: '' });
      } catch (error) {
        if (list !== this.listGeneration || this.denied(error, generation)) return;
        this.publish({ phase: 'error', ...this.countPatch(countToken, null), error: '通知列表暂不可用，请重试；上次结果可能已变化。' });
      } finally {
        if (generation === this.generation && list === this.listGeneration) { this.reading = null; this.publish({ refreshing: false }); }
      }
    })();
    this.reading = reading; return reading;
  };
  filter = async (query: Partial<Omit<Query, 'after'>>) => {
    if (this.state.busy || this.state.pending) return;
    this.cancelList(); this.publish({ query: { ...this.state.query, ...query, after: '' }, items: [], history: [], nextCursor: null });
    await this.refresh();
  };
  next = async () => {
    if (!this.state.nextCursor || this.state.refreshing || this.state.busy || this.state.pending) return;
    const after = this.state.nextCursor;
    this.publish({ history: [...this.state.history, this.state.query.after], query: { ...this.state.query, after }, items: [] }); await this.refresh();
  };
  back = async () => {
    if (!this.state.history.length || this.state.refreshing || this.state.busy || this.state.pending) return;
    const history = this.state.history.slice(), after = history.pop()!;
    this.publish({ history, query: { ...this.state.query, after }, items: [] }); await this.refresh();
  };
  closeDetail = () => { this.detailGeneration++; this.channels.get('detail')?.abort(); this.publish({ detail: { phase: 'idle', item: null, error: '' } }); };
  open = async (row: NotificationItem) => {
    if (!this.state.identityKey || this.state.busy || this.state.pending) return;
    const generation = this.generation, detail = ++this.detailGeneration;
    const countToken = row.source === 'announcement' ? ++this.countGeneration : this.countGeneration;
    this.publish({ detail: { phase: 'loading', item: null, error: '' }, error: '', success: '' });
    let item = row;
    if (row.source === 'announcement') {
      try {
        const result = await this.request('/api/user/announcements/' + encodeURIComponent(row.referenceId) + (this.state.query.history ? '?history=true' : ''), 'detail') as { announcement: NotificationItem & { publishedAt: string }; unreadCount: number };
        if (generation !== this.generation || detail !== this.detailGeneration) return;
        const value = result?.announcement;
        if (!value || typeof value.body !== 'string' || typeof value.title !== 'string' || typeof value.isRead !== 'boolean'
          || !['published', 'expired'].includes(value.status) || !Number.isFinite(Date.parse(value.publishedAt)) || !countIsValid(result.unreadCount)) throw new Error('invalid_detail');
        item = { ...row, referenceId: value.id, title: value.title, body: value.body, isRead: value.isRead,
          createdAt: value.publishedAt, status: value.status, severity: value.severity, pinned: value.pinned, expiresAt: value.expiresAt };
        this.publish(this.countPatch(countToken, result.unreadCount));
      } catch (error) {
        if (detail !== this.detailGeneration || this.denied(error, generation)) return;
        this.publish({ ...this.countPatch(countToken, null), detail: { phase: statusOf(error) === 404 ? 'missing' : 'error', item: null,
          error: statusOf(error) === 404 ? '公告已结束、撤回或不可见，未标记已读。' : '公告详情读取失败，未标记已读，请关闭后重新选择。' } }); return;
      }
    }
    if (generation !== this.generation || detail !== this.detailGeneration) return;
    this.publish({ detail: { phase: 'ready', item, error: '' } });
    if (!this.state.canWrite || item.isRead || (item.source === 'announcement' && item.status !== 'published')) return;
    await this.send({ path: item.source === 'announcement' ? '/api/user/announcements/' + encodeURIComponent(item.referenceId) + '/read'
      : '/api/user/notifications/' + encodeURIComponent(item.referenceId), method: item.source === 'announcement' ? 'POST' : 'PATCH',
      body: JSON.stringify(item.source === 'announcement' ? {} : { read: true }), item });
  };
  markAll = async () => {
    if (!this.state.identityKey || !this.state.canWrite || this.state.busy || this.state.pending || this.state.unreadCount === null) return;
    await this.send({ path: '/api/user/notifications/read-all', method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID() }) });
  };
  retry = async () => { if (this.state.identityKey && this.state.canWrite && !this.state.busy && this.state.pending) await this.send(this.state.pending); };
  private async send(command: Command) {
    if (this.state.busy || (this.state.pending && this.state.pending !== command)) return;
    const generation = this.generation;
    const countToken = ++this.countGeneration;
    this.cancelList(); this.publish({ busy: true, pending: command, error: '', success: '', refreshing: false });
    try {
      const result = await this.request(command.path, 'mutation', command) as { ok: boolean; unreadCount: number };
      if (generation !== this.generation) return;
      if (!result || result.ok !== true || !countIsValid(result.unreadCount)) throw new Error('invalid_read_result');
      this.publish({ busy: false, pending: null, ...this.countPatch(countToken, result.unreadCount), success: '已读操作已确认。',
        ...(command.item && this.state.detail.item?.id === command.item.id ? { detail: { ...this.state.detail, item: { ...this.state.detail.item, isRead: true } } } : {}) });
      await this.refresh();
    } catch (error) {
      if (this.denied(error, generation)) return;
      const rejected = [400, 404, 409, 413, 415, 422].includes(statusOf(error));
      this.publish({ busy: false, pending: rejected ? null : command, ...this.countPatch(countToken, null),
        ...(statusOf(error) === 404 && command.item ? { detail: { phase: 'missing' as const, item: null, error: '通知已不可见，未标记已读。' } } : {}),
        error: rejected ? '已读操作被拒绝，请刷新通知后核对。' : '尚未确认已读结果，请重试原请求；不会乐观清零或重复减数。' });
    }
  }
}

// Visible-only polling is independent of App refresh and never refreshes platform capabilities.
export function watchNotifications(model: NotificationSession, windowTarget: EventTarget, documentTarget: EventTarget & { visibilityState: string }) {
  const refresh = () => { if (documentTarget.visibilityState === 'visible') void model.refresh(); };
  windowTarget.addEventListener('focus', refresh); documentTarget.addEventListener('visibilitychange', refresh);
  const timer = setInterval(refresh, 30000);
  return () => { clearInterval(timer); windowTarget.removeEventListener('focus', refresh); documentTarget.removeEventListener('visibilitychange', refresh); };
}
