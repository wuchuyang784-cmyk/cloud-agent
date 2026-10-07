import type { MonitoringState } from './session';

export function AlertsView({ value }: { value: MonitoringState }) {
  if (value.phase === 'loading') return <div className="panel-state">正在读取当前告警…</div>;
  if (value.phase === 'error') return <div className="panel-state warning" role="status">{value.error}</div>;
  const items = ((value.data as { items?: { name: string; severity: string; state: string; activeAt: string | null; instance: string | null }[] } | null)?.items ?? []);
  return <section><p className="section-note">这里只显示 Prometheus 当前告警，不是通知历史。</p><div className="table-scroll"><table><thead><tr><th>告警</th><th>级别</th><th>状态</th><th>实例</th><th>开始时间</th></tr></thead>
    <tbody>{items.map((item, index) => <tr key={item.name + index}><td><strong>{item.name}</strong></td><td><span className={'badge ' + (item.severity === 'critical' ? 'negative' : '')}>{item.severity}</span></td><td>{item.state}</td><td><code>{item.instance || '—'}</code></td><td>{item.activeAt ? new Date(item.activeAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td></tr>)}
      {!items.length && <tr><td colSpan={5}><div className="empty">当前没有告警</div></td></tr>}</tbody></table></div></section>;
}
