import { useEffect, useState } from 'react';
import type { MonitoringState } from './session';
import { monitoringTarget } from './monitoring-target';

function GrafanaFrame({ url }: { url: string }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    setPhase('loading');
    const controller = new AbortController(); let cancelled = false;
    const timer = setTimeout(() => controller.abort(), 8000);
    void fetch('/api/admin/grafana/api/health', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(); if (!cancelled) setPhase('ready'); })
      .catch(() => { if (!cancelled) setPhase('error'); }).finally(() => clearTimeout(timer));
    return () => { cancelled = true; clearTimeout(timer); controller.abort(); };
  }, [url]);
  if (phase === 'loading') return <div className="panel-state" role="status">正在连接 Grafana 面板…</div>;
  if (phase === 'error') return <div className="panel-state warning" role="status">Grafana 暂不可用，请刷新重试；用户账号和 Agent 管理不受影响。</div>;
  return <iframe title="BaiRui 平台运行监控" src={url} referrerPolicy="same-origin" />;
}

export function MonitoringView({ value, onRetry }: { value: MonitoringState; onRetry: () => void }) {
  const [revision, setRevision] = useState(0);
  const [dashboard, setDashboard] = useState<'platform' | 'host'>('platform');
  const retry = () => { setRevision(value => value + 1); onRetry(); };
  if (value.phase === 'loading') return <div className="panel-state">正在验证监控入口…</div>;
  const target = monitoringTarget(value.data, dashboard);
  if (value.phase !== 'ready' || !target) return <div className="panel-state warning" role="status"><span>{value.error || '当前环境未配置运行监控。'}</span><button onClick={retry}>刷新监控</button></div>;
  return <section className="monitor-shell"><div className="monitor-toolbar"><div className="monitor-note"><strong>只读运行监控 · {target.scope === 'business' ? '业务环境' : '预发环境'}</strong>
    <span>{target.scope === 'business' ? '当前 API、业务数据库、宿主机及业务 / 预发 Controller 的真实采样，每 15 秒更新。' : '预发 API、数据库及 Controller 的真实采样，每 15 秒更新。'}</span>
    <small>主机资源：本批仅支持原生 Linux；Docker Desktop 的 Linux VM 不能作为物理宿主机指标。缺失或超过 45 秒的样本显示不可用。</small>
    <small>使用当前平台账号；每次请求重新校验权限，不需要另一套 Grafana 登录。</small></div><div className="monitor-actions">
      <button aria-pressed={dashboard === 'platform'} onClick={() => setDashboard('platform')}>平台运行</button>
      <button aria-pressed={dashboard === 'host'} onClick={() => setDashboard('host')}>主机资源</button>
      <button onClick={retry}>刷新监控</button></div></div>
    <GrafanaFrame key={`${target.scope}:${target.url}:${revision}`} url={target.url} />
  </section>;
}
