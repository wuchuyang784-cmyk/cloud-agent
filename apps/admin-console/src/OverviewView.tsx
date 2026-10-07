import { Activity, CircleAlert, Database, Gauge, Server, Timer } from 'lucide-react';
import type { MonitoringState } from './session';

const cards = [
  ['apiReplicas', 'API 可用副本', Server], ['databaseReady', '数据库就绪', Database], ['requestRate', '请求速率', Activity],
  ['latencyP95', 'P95 延迟', Timer], ['errorRate', '5xx 比率', Gauge], ['firingAlerts', '触发中告警', CircleAlert],
] as const;

export function OverviewView({ value }: { value: MonitoringState }) {
  if (value.phase === 'loading') return <div className="panel-state">正在读取平台运行概览…</div>;
  if (value.phase === 'error') return <div className="panel-state warning" role="status">{value.error}</div>;
  const data = value.data as { status?: string; metrics?: Record<string, { status?: string; value?: number | null; sampledAt?: string | null }> } | null;
  return <div className="metric-grid">{cards.map(([key, label, Icon]) => {
    const metric = data?.metrics?.[key];
    return <article className="metric-card" key={key}><Icon size={20} /><span>{label}</span><strong>{metric?.value ?? '—'}</strong>
      <small>{metric?.status === 'stale' ? '数据已陈旧' : metric?.sampledAt ? new Date(metric.sampledAt).toLocaleTimeString('zh-CN', { hour12: false }) : '暂无采样'}</small></article>;
  })}</div>;
}
