export type View = 'users' | 'agents';
export type Query = { view: View; q?: string; after?: string; limit?: string; ownerUserId?: string; status?: string };
export type Row = { id: string; email?: string; displayName?: string | null; createdAt?: string | null;
  authLinked?: boolean; name?: string; ownerUserId?: string; ownerEmail?: string; status?: string; engine?: string; updatedAt?: string };
export type Identity = { role: string; permissions: string[]; user: { id: string; email: string } };
export type Phase = 'loading' | 'ready' | 'login' | 'denied' | 'error' | 'signing-out' | 'logout-error';
export type Snapshot = { phase: Phase; me: Identity | null; items: Row[]; nextCursor: string | null; error: string; updatedAt: number | null };
type Transport = (path: string, init?: RequestInit) => Promise<Response>;

class HttpError extends Error {
  status: number;
  constructor(status: number) { super('request_failed'); this.status = status; }
}

export class AdminSession {
  private transport: Transport;
  private state: Snapshot = { phase: 'loading', me: null, items: [], nextCursor: null, error: '', updatedAt: null };
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort = new AbortController();
  private locked = false;
  constructor(transport: Transport = (path, init) => fetch(path, init)) { this.transport = transport; }
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
    this.publish({ phase, me: null, items: [], nextCursor: null, error: '', updatedAt: null });
    return { generation, signal: this.abort.signal };
  }
  cancel = () => { if (!this.locked) { this.generation++; this.abort.abort(); } };
  private async json(path: string, signal: AbortSignal, body?: object) {
    const result = await this.transport(path, { signal, credentials: 'same-origin', cache: 'no-store',
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!result.ok) throw new HttpError(result.status);
    return result.json();
  }
  private fail(error: unknown, generation: number, signingIn = false) {
    if (generation !== this.generation) return;
    const code = error instanceof HttpError ? error.status : 0;
    const phase = code === 401 ? 'login' : code === 403 ? 'denied' : signingIn ? 'login' : 'error';
    this.publish({ phase, me: null, items: [], nextCursor: null, updatedAt: null,
      error: code === 429 ? '请求过于频繁，请稍后再试。' : code === 401 ? (signingIn ? '邮箱或密码错误。' : '') : code === 403 ? '当前账号没有平台管理权限。' : '请求未完成，请稍后重试。' });
  }
  private async read(query: Query, generation: number, signal: AbortSignal) {
    const me = await this.json('/api/admin/me', signal) as Identity;
    if (generation !== this.generation) return;
    if (!['platform_viewer', 'platform_operator', 'platform_admin'].includes(me.role)
      || !me.permissions?.includes(query.view + ':read') || !me.user?.id) throw new HttpError(403);
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
