import type { MonitoringState } from './session';

export function MonitoringView({ value }: { value: MonitoringState }) {
  if (value.phase === 'loading') return <div className="panel-state">正在验证监控入口…</div>;
  if (value.phase !== 'ready') return <div className="panel-state warning" role="status">{value.error || '当前环境未配置运行监控。'}</div>;
  return <section className="monitor-shell"><div className="monitor-note"><strong>只读运行监控</strong><span>每个请求都会重新校验当前平台账号；独立 Grafana 管理员仅用于应急。</span></div>
    <iframe title="BaiRui 平台运行监控" src="https://localhost:9443/d/bairui-platform/bairui-platform?kiosk" referrerPolicy="same-origin" />
  </section>;
}
