import type { Infrastructure } from './infrastructure';
export type View = 'users' | 'agents' | 'infrastructure';
export type Query = { view: View; q?: string; after?: string; limit?: string; ownerUserId?: string; status?: string };
export type Row = { id: string; email?: string; displayName?: string | null; createdAt?: string | null;
  authLinked?: boolean; name?: string; ownerUserId?: string; ownerEmail?: string; status?: string; engine?: string; updatedAt?: string; account?: AccountState };
export type AccountState = { status: 'active' | 'suspended' | 'banned'; version: number; changedAt?: string | null };
type Command = { status: AccountState['status']; expectedVersion: number; reason: string; requestId: string };
export type Governance = { target: Row; account: AccountState | null; items: { id: string; actorUserId: string; status: string; previousStatus: string; reason: string; occurredAt: string }[];
  nextCursor: string | null; busy: boolean; error: string; success: string; retry: Command | null };
export type Identity = { role: string; permissions: string[]; user: { id: string; email: string } };
export type Phase = 'loading' | 'ready' | 'login' | 'denied' | 'error' | 'signing-out' | 'logout-error';
export type Snapshot = { phase: Phase; me: Identity | null; items: Row[]; nextCursor: string | null; infrastructure: Infrastructure | null; error: string; updatedAt: number | null; governance: Governance | null };
type Transport = (path: string, init?: RequestInit) => Promise<Response>;

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code = '') { super('request_failed'); this.status = status; this.code = code; }
}

export class AdminSession {
  private transport: Transport;
  private state: Snapshot = { phase: 'loading', me: null, items: [], nextCursor: null, infrastructure: null, error: '', updatedAt: null, governance: null };
  private detailGeneration = 0;
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort = new AbortController();
  private locked = false;
  private timeoutMs: number;
  constructor(transport: Transport = (path, init) => fetch(path, init), timeoutMs = 15000) { this.transport = transport; this.timeoutMs = timeoutMs; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: Partial<Snapshot>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach(listener => listener());
  }
  private begin(phase: Phase) {
    this.abort.abort();
    this.abort = new AbortController();
    const generation = ++this.generation;
    this.detailGeneration++;
    this.publish({ phase, me: null, items: [], nextCursor: null, infrastructure: null, error: '', updatedAt: null, governance: null });
    return { generation, signal: this.abort.signal };
  }
  cancel = () => { if (!this.locked) { this.generation++; this.abort.abort(); } };
  private async json(path: string, signal: AbortSignal, body?: object) {
    const timeout = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const result = await this.transport(path, { signal: AbortSignal.any([signal, timeout.signal]), credentials: 'same-origin', cache: 'no-store',
            ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
          if (!result.ok) { const value = await result.json().catch(() => ({})); throw new HttpError(result.status, value.error?.code || value.code || ''); }
          return result.json();
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { timeout.abort(); reject(new Error('request_timeout')); }, this.timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  private fail(error: unknown, generation: number, signingIn = false) {
    if (generation !== this.generation) return;
    const code = error instanceof HttpError ? error.status : 0;
    const phase = code === 401 ? 'login' : code === 403 ? 'denied' : signingIn ? 'login' : 'error';
    this.publish({ phase, me: null, items: [], nextCursor: null, infrastructure: null, updatedAt: null, governance: null,
      error: code === 429 ? '请求过于频繁，请稍后再试。' : code === 401 ? (signingIn ? '邮箱或密码错误。' : '') : code === 403 ? '当前账号没有平台管理权限。' : '请求未完成，请稍后重试。' });
  }
  private async read(query: Query, generation: number, signal: AbortSignal) {
    const me = await this.json('/api/admin/me', signal) as Identity;
    if (generation !== this.generation) return;
    if (!['platform_viewer', 'platform_operator', 'platform_admin'].includes(me.role)
      || !me.permissions?.includes(query.view + ':read') || !me.user?.id) throw new HttpError(403);
    if (query.view === 'infrastructure') {
      const infrastructure = await this.json('/api/admin/infrastructure', signal) as Infrastructure;
      if (generation !== this.generation) return;
      if (!Array.isArray(infrastructure.items) || infrastructure.items.length > 20
        || !Number.isFinite(Date.parse(infrastructure.observedAt)) || infrastructure.staleAfterSeconds !== 90) throw new Error('invalid_infrastructure');
      this.publish({ phase: 'ready', me, infrastructure, items: [], nextCursor: null, error: '', updatedAt: Date.now() });
      return;
    }
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (key !== 'view' && value) params.set(key, value);
    const page = await this.json('/api/admin/' + query.view + '?' + params, signal);
    if (generation !== this.generation) return;
    if (!Array.isArray(page.items) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw new Error('invalid_page');
    this.publish({ phase: 'ready', me, items: page.items, nextCursor: page.nextCursor, error: '', updatedAt: Date.now() });
  }
  load = async (query: Query) => {
    if (this.locked) return;
    const { generation, signal } = this.begin('loading');
    try { await this.read(query, generation, signal); }
    catch (error) { this.fail(error, generation); }
  };
  closeGovernance = () => { this.detailGeneration++; this.publish({ governance: null }); };
  openGovernance = async (target: Row, after = '') => {
    if (this.locked || this.state.phase !== 'ready') return;
    const generation = this.generation, detail = ++this.detailGeneration;
    this.publish({ governance: { target, account: null, items: [], nextCursor: null, busy: true, error: '', success: '', retry: null } });
    try {
      const data = await this.json('/api/admin/users/' + encodeURIComponent(target.id) + '/governance' + (after ? '?after=' + encodeURIComponent(after) : ''), this.abort.signal);
      if (generation !== this.generation || detail !== this.detailGeneration) return;
      this.validateGovernance(data);
      this.publish({ governance: { ...this.state.governance!, ...data, busy: false }, items: this.state.items.map(row => row.id === target.id ? { ...row, account: data.account } : row) });
    } catch (error) {
      if (generation !== this.generation || detail !== this.detailGeneration) return;
      if (error instanceof HttpError && [401, 403].includes(error.status)) return this.fail(error, generation);
      this.publish({ governance: { ...this.state.governance!, busy: false, error: '账号状态读取失败，请刷新。' } });
    }
  };
  private validateGovernance(data: { account?: AccountState; items?: unknown; nextCursor?: unknown }) {
    if (!data.account || !['active', 'suspended', 'banned'].includes(data.account.status) || !Number.isSafeInteger(data.account.version)
      || !Array.isArray(data.items) || data.items.length > 25 || !(data.nextCursor === null || typeof data.nextCursor === 'string')) throw new Error('invalid_governance');
  }
  govern = async (status: AccountState['status'], reason: string) => {
    const current = this.state.governance;
    if (this.locked || this.state.phase !== 'ready' || !current?.account || current.busy
      || !this.state.me?.permissions.includes('users:govern') || current.target.id === this.state.me.user.id) return;
    const generation = this.generation, detail = ++this.detailGeneration;
    const command = current.retry ?? { status, reason: reason.trim(), expectedVersion: current.account.version, requestId: crypto.randomUUID() };
    this.publish({ governance: { ...current, busy: true, error: '', success: '', retry: command } });
    let confirmed = false;
    try {
      await this.json('/api/admin/users/' + encodeURIComponent(current.target.id) + '/governance', this.abort.signal, command);
      confirmed = true;
      if (generation !== this.generation || detail !== this.detailGeneration) return;
      const data = await this.json('/api/admin/users/' + encodeURIComponent(current.target.id) + '/governance', this.abort.signal);
      if (generation !== this.generation || detail !== this.detailGeneration) return;
      this.validateGovernance(data);
      this.publish({ governance: { ...current, ...data, busy: false, error: '', success: '操作已确认', retry: null },
        items: this.state.items.map(row => row.id === current.target.id ? { ...row, account: data.account } : row) });
    } catch (error) {
      if (generation !== this.generation || detail !== this.detailGeneration) return;
      if (error instanceof HttpError && [401, 403].includes(error.status)) return this.fail(error, generation);
      const conflict = error instanceof HttpError && error.status >= 400 && error.status < 500;
      const messages: Record<string, string> = { version_conflict: '账号状态已变更，请刷新后重新确认。', self_governance_forbidden: '不能操作当前登录账号。',
        last_admin_protected: '不能限制最后一个有效管理员。', idempotency_conflict: '请求号已用于其他操作，请刷新。', state_unchanged: '账号已处于该状态，请刷新。' };
      this.publish({ governance: { ...current, account: confirmed || conflict ? null : current.account, busy: false, success: '',
        retry: confirmed || conflict ? null : command, error: confirmed ? '操作已提交，但状态读取失败，请刷新核对。'
          : conflict ? messages[(error as HttpError).code] || '操作被拒绝，请刷新后重试。' : '尚未确认操作结果，可重试原请求或刷新核对。' } });
    }
  };
  signIn = async (email: string, password: string, query: Query = { view: 'users' }) => {
    this.locked = false;
    const { generation, signal } = this.begin('loading');
    try {
      await this.json('/api/auth/sign-in/email', signal, { email, password });
      if (generation === this.generation) await this.read(query, generation, signal);
    } catch (error) { this.fail(error, generation, true); }
  };
  signOut = async () => {
    this.locked = true;
    const { generation, signal } = this.begin('signing-out');
    try {
      await this.json('/api/auth/sign-out', signal, {});
      if (generation === this.generation) this.publish({ phase: 'login' });
    } catch {
      if (generation === this.generation) this.publish({ phase: 'logout-error', error: '服务器尚未确认退出，请重试。' });
    }
  };
}
