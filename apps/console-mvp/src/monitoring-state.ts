export type MonitoringState<T> = { phase: 'idle' | 'loading' | 'ready' | 'error' | 'missing';
  key: string; data: T | null; error: string };

export class MonitoringResource<T> {
  private state: MonitoringState<T> = { phase: 'idle', key: '', data: null, error: '' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: MonitoringState<T>) { this.state = state; this.listeners.forEach(listener => listener()); }
  private stopTimer() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  clear = () => {
    this.stopTimer();
    this.generation++; this.abort?.abort();
    this.publish({ phase: 'idle', key: '', data: null, error: '' });
  };
  load = async (key: string, read: (signal: AbortSignal) => Promise<T>, timeoutMs = 15000) => {
    this.stopTimer();
    this.abort?.abort(); this.abort = new AbortController();
    const generation = ++this.generation;
    this.publish({ phase: 'loading', key, data: null, error: '' });
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.timer = null; this.generation++; this.abort?.abort();
      this.publish({ phase: 'error', key, data: null, error: '监控数据读取超时，请重试' });
    }, timeoutMs);
    try {
      const data = await read(this.abort.signal);
      if (generation === this.generation) this.publish({ phase: 'ready', key, data, error: '' });
    } catch (error) {
      if (generation !== this.generation) return;
      const status = (error as { status?: number })?.status;
      this.publish({ phase: status === 404 ? 'missing' : 'error', key, data: null,
        error: status === 404 ? 'Agent 不存在或已无访问权限' : status === 401 ? '会话已过期，请重新登录' : '监控数据读取失败，请重试' });
    } finally { if (generation === this.generation) this.stopTimer(); }
  };
}
