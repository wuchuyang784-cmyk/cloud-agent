import { useEffect, useState } from 'react';
import { Cpu, HardDrive, RefreshCw, Server } from 'lucide-react';
import type { Infrastructure, InfraSource } from './infrastructure';

const count = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const bytes = (n: number) => n >= 1024 ** 3 ? count(n / 1024 ** 3) + ' GiB' : count(n / 1024 ** 2) + ' MiB';
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未采样';
const nodeStates: Record<string, string> = { ready: '就绪', down: '离线', disconnected: '断开', unknown: '未知' };
const availability: Record<string, string> = { active: '可调度', pause: '暂停分配', drain: '排空中' };
const sourceStates: Record<string, string> = { fresh: '采样正常', stale: '采样已过期', waiting: '等待采集', invalid: '采样异常' };
const swarmStates: Record<string, string> = { disabled: 'Swarm 采集未启用', unavailable: 'Swarm 采集不可用', unsupported: '当前环境不支持 Swarm 采集' };

function Source({ source, stale }: { source: InfraSource; stale: boolean }) {
  const status = stale ? 'stale' : source.status;
  const sample = source.snapshot;
  return <section className={'infra-source ' + (stale ? 'is-stale' : '')} aria-label={source.label}>
    <div className="infra-heading"><div><h2><Server size={19} />{source.label}</h2><code>{source.sourceId}</code></div>
      <div className="infra-sample"><span className={'badge ' + (status === 'fresh' ? 'positive' : status === 'waiting' ? '' : 'negative')}>{sourceStates[status]}</span><span>采样时间 {time(source.sampledAt)}</span></div></div>
    {sample ? <>
      <h3>采集主机 <span>{({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' } as Record<string, string>)[sample.host.platform]}</span></h3>
      <dl className="infra-metrics">
        <div><dt><Cpu size={16} /> CPU 使用率</dt><dd>{sample.host.cpuPercent === null ? '未采样' : count(sample.host.cpuPercent) + '%'}</dd>
          {sample.host.cpuPercent !== null && <meter aria-label="主机 CPU 使用率" value={sample.host.cpuPercent} min={0} max={100} />}</div>
        <div><dt>逻辑 CPU</dt><dd>{sample.host.cpuCount}<small> 核</small></dd></div>
        <div><dt><HardDrive size={16} /> 内存使用量</dt><dd>{bytes(sample.host.memoryUsedBytes)}</dd><meter className="memory-meter" aria-label="主机内存使用率" value={sample.host.memoryUsedBytes} min={0} max={sample.host.memoryTotalBytes} /></div>
        <div><dt>内存总量</dt><dd>{bytes(sample.host.memoryTotalBytes)}</dd><span className="subtext">可用 {bytes(sample.host.memoryTotalBytes - sample.host.memoryUsedBytes)}</span></div>
      </dl>
      <div className="infra-heading"><h3>Swarm 节点资源</h3><span className="subtext">节点实测 CPU / 内存：未采集</span></div>
      {sample.swarm.status !== 'ok' ? <div className="infra-notice" role="status">{swarmStates[sample.swarm.status] || 'Swarm 数据不可用'}</div> : <>
        <div className="table-scroll"><table className="infra-nodes"><thead><tr><th>节点 / 状态</th><th>CPU 容量 / 预留</th><th>内存容量 / 预留</th><th>任务限制合计</th><th>任务</th></tr></thead><tbody>
          {sample.swarm.nodes.map(node => <tr key={node.id}><td><strong>{node.name}</strong><span className={'subtext ' + (node.state !== 'ready' ? 'error' : '')}>{nodeStates[node.state]} · {availability[node.availability]}</span></td>
            <td>{count(node.cpuCores)} / {count(node.reservedCpuCores)} 核<span className="subtext">未预留 {count(Math.max(0, node.cpuCores - node.reservedCpuCores))} 核</span>{node.reservedCpuCores > node.cpuCores && <span className="error">预留超出容量</span>}</td>
            <td>{bytes(node.memoryBytes)} / {bytes(node.reservedMemoryBytes)}<span className="subtext">未预留 {bytes(Math.max(0, node.memoryBytes - node.reservedMemoryBytes))}</span>{node.reservedMemoryBytes > node.memoryBytes && <span className="error">预留超出容量</span>}</td>
            <td>{count(node.limitedCpuCores)} 核 / {bytes(node.limitedMemoryBytes)}<span className="subtext">未设上限：CPU {node.unlimitedCpuTasks} · 内存 {node.unlimitedMemoryTasks}</span></td>
            <td>运行中 {node.runningTasks}<span className="subtext">非终态 {node.activeTasks}</span></td></tr>)}
        </tbody></table></div>
        <div className="infra-heading"><h3>服务调度</h3><span className={'badge ' + (sample.swarm.unassignedTasks ? 'negative' : '')}>未分配节点 {sample.swarm.unassignedTasks}</span></div>
        <div className="table-scroll"><table><thead><tr><th>服务</th><th>运行 / 期望副本</th><th>启动等待</th><th>单任务预留</th><th>单任务限制</th></tr></thead><tbody>
          {sample.swarm.services.map(service => <tr key={service.id}><td><strong>{service.name}</strong><code className="subtext">{service.id}</code></td><td>{service.runningTasks} / {service.desiredTasks ?? (service.mode === 'global' ? '按节点' : '未采集')}</td>
            <td>{service.pendingTasks}</td><td>{count(service.reservedCpuPerTask)} 核 / {bytes(service.reservedMemoryPerTask)}</td><td>{service.limitCpuPerTask === null ? 'CPU 未设上限' : count(service.limitCpuPerTask) + ' 核'}<span className="subtext">{service.limitMemoryPerTask === null ? '内存未设上限' : bytes(service.limitMemoryPerTask)}</span></td></tr>)}
          {!sample.swarm.services.length && <tr><td colSpan={5} className="infra-notice">暂无 Swarm 服务</td></tr>}
        </tbody></table></div>
      </>}
    </> : <div className="infra-notice" role="status">{sourceStates[status]}</div>}
  </section>;
}

export function InfrastructureView({ data, busy, updatedAt, refresh }: { data: Infrastructure | null; busy: boolean; updatedAt: number | null; refresh: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10000); return () => clearInterval(timer); }, []);
  const elapsed = updatedAt ? Math.max(0, now - updatedAt) : 0;
  return <div className="infrastructure-view">
    <div className="toolbar"><span className="updated">{updatedAt ? '读取于 ' + time(new Date(updatedAt).toISOString()) : ''}</span><div className="toolbar-end"><button className="icon-button" title="刷新服务器资源" aria-label="刷新服务器资源" disabled={busy} onClick={refresh}><RefreshCw size={17} className={busy ? 'spin' : ''} /></button></div></div>
    {busy ? <div className="empty" role="status"><RefreshCw className="spin" size={24} /><span>正在读取资源快照</span></div>
      : !data?.items.length ? <div className="empty" role="status"><Server size={30} /><span>尚未配置采集源</span></div>
        : data.items.map(source => <Source key={source.sourceId} source={source} stale={source.status === 'stale' || Boolean(source.status === 'fresh' && source.sampledAt && source.receivedAt && Date.parse(data.observedAt) + elapsed - Math.min(Date.parse(source.sampledAt), Date.parse(source.receivedAt)) > data.staleAfterSeconds * 1000)} />)}
    {data?.truncated && <p className="error" role="status">当前仅展示前 20 个采集源。</p>}
  </div>;
}
