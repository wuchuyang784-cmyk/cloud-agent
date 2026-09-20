import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Activity, ChevronLeft, ChevronRight, CircleAlert, Clock3, Cpu, Database, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { fetchAgentMonitoring, fetchMonitoredAgents, type AgentMonitoring, type MonitoredAgent, type MonitoringPage, type MonitoringRange } from './api';
import { MonitoringResource } from './monitoring-state';
import './monitoring.css';

const statusLabels: Record<string, string> = { uninitialized: '未初始化', provisioning: '配置中', starting: '启动中',
  ready: '已就绪', degraded: '已降级', offline: '已离线', failed: '失败', stopped: '已停止', unknown: '未知' };
const freshnessLabels = { missing: '无路由记录', recent: '近期记录', stale: '记录陈旧', invalid: '记录时间异常' };
const time = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : '暂无';
const number = (value: number | null) => value === null ? '--' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);

function RouteStatus({ agent, now }: { agent: MonitoredAgent; now: number }) {
  const record = agent.routeRecord;
  const freshness = record.freshness === 'recent' && record.recordedAt
    && now - Date.parse(record.recordedAt) > record.staleAfterSeconds * 1000 ? 'stale' : record.freshness;
  return <span className={'monitor-badge ' + freshness}><Clock3 />{freshnessLabels[freshness]}</span>;
}

export function ClientMonitoring() {
  const listModel = useMemo(() => new MonitoringResource<MonitoringPage>(), []);
  const detailModel = useMemo(() => new MonitoringResource<AgentMonitoring>(), []);
  const list = useSyncExternalStore(listModel.subscribe, listModel.getSnapshot);
  const detail = useSyncExternalStore(detailModel.subscribe, detailModel.getSnapshot);
  const [search, setSearch] = useState('');
  const [q, setQuery] = useState('');
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<MonitoringRange>('today');
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const after = cursors.at(-1);
  const listKey = JSON.stringify([q, after, refresh]);
  const detailKey = JSON.stringify([selected, range, refresh]);
  const page = list.key === listKey ? list.data : null;
  const data = detail.key === detailKey && selected ? detail.data : null;
  const listBusy = list.key !== listKey || list.phase === 'loading';
  const detailBusy = !!selected && (detail.key !== detailKey || detail.phase === 'loading');
  useEffect(() => {
    void listModel.load(listKey, signal => fetchMonitoredAgents(q, after, signal));
    return listModel.clear;
  }, [listModel, listKey, q, after]);
  useEffect(() => {
    if (page) setSelected(current => page.items.some(item => item.id === current) ? current : page.items[0]?.id ?? null);
  }, [page]);
  useEffect(() => {
    if (selected) void detailModel.load(detailKey, signal => fetchAgentMonitoring(selected, range, signal));
    else detailModel.clear();
    return detailModel.clear;
  }, [detailModel, selected, range, detailKey]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, []);
  const retry = () => { setNow(Date.now()); setRefresh(value => value + 1); };
  const listError = list.key === listKey && list.phase === 'error';
  const detailError = detail.key === detailKey && ['error', 'missing'].includes(detail.phase);

  return <div className="client-monitoring">
    <header className="monitor-heading"><div><h1>可观测</h1><span>我的 Agent</span></div>
      <button className="icon-button" title="刷新监控数据" aria-label="刷新监控数据" onClick={retry} disabled={listBusy || detailBusy}>
        <RefreshCw className={listBusy || detailBusy ? 'spin' : ''} /></button></header>
    <form className="monitor-toolbar" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setCursors([undefined]); setSelected(null); retry(); }}>
      <label className="monitor-search"><Search /><input aria-label="搜索我的 Agent" maxLength={100} placeholder="搜索 Agent 名称或 ID" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <button type="submit" className="icon-button" title="搜索 Agent" aria-label="搜索 Agent" disabled={listBusy}><Search /></button>
      {page && <span className="monitor-read-time">读取于 {time(page.fetchedAt)}{now - Date.parse(page.fetchedAt) > 300000 && ' · 页面数据已过期'}</span>}
    </form>
    {listBusy && <div className="monitor-empty" role="status"><LoaderCircle className="spin" />正在读取</div>}
    {listError && <div className="monitor-error" role="alert"><CircleAlert /><span>{list.error}</span><button className="text-button" onClick={retry}>重试</button></div>}
    {page && page.items.length === 0 && <div className="monitor-empty"><Activity /><h2>{q ? '没有匹配的 Agent' : '暂无 Agent 记录'}</h2></div>}
    {page && page.items.length > 0 && <>
      <div className="monitor-table-scroll"><table className="monitor-table" aria-label="我的 Agent 监控列表">
        <thead><tr><th>Agent</th><th>引擎</th><th>登记状态</th><th>路由记录</th><th>路由记录时间</th></tr></thead>
        <tbody>{page.items.map(item => <tr key={item.id} aria-selected={selected === item.id}>
          <td><button className="monitor-agent" onClick={() => setSelected(item.id)} aria-label={'查看 ' + item.name + ' 的监控'}><strong>{item.name}</strong><small>{item.id}</small></button></td>
          <td>{item.engine === 'mock' ? '模拟 Runtime' : item.engine === 'pi' ? 'Pi' : item.engine === 'dsh' ? 'DeepSeek' : '未知'}</td>
          <td>{statusLabels[item.recordStatus] ?? '未知'}</td><td><RouteStatus agent={item} now={now} /></td><td>{time(item.routeRecord.recordedAt)}</td>
        </tr>)}</tbody></table></div>
    </>}
    {page && <nav className="monitor-pagination" aria-label="监控分页"><span>第 {cursors.length} 页 · 本页 {page.items.length} 条</span>
      <button className="icon-button" title="上一页" aria-label="监控上一页" disabled={cursors.length === 1} onClick={() => { setSelected(null); setCursors(values => values.slice(0, -1)); }}><ChevronLeft /></button>
      <button className="icon-button" title="下一页" aria-label="监控下一页" disabled={!page.nextCursor} onClick={() => { setSelected(null); setCursors(values => [...values, page.nextCursor ?? undefined]); }}><ChevronRight /></button></nav>}

    {selected && page && <section className="monitor-detail" aria-label="Agent 监控详情">
      <header className="monitor-detail-heading"><h2>{page.items.find(item => item.id === selected)?.name}</h2>
        <div className="monitor-ranges" role="group" aria-label="用量时间范围">{([['today', '今日'], ['7d', '近 7 天'], ['30d', '近 30 天']] as const).map(([value, label]) =>
          <button key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}</div></header>
      {detailBusy && <div className="monitor-empty" role="status"><LoaderCircle className="spin" />正在读取 Agent 记录</div>}
      {detailError && <div className="monitor-error" role="alert"><CircleAlert /><span>{detail.error}</span><button className="text-button" onClick={retry}>重试</button></div>}
      {data && <>
        <dl className="monitor-metadata"><div><dt>登记更新时间</dt><dd>{time(data.agent.recordUpdatedAt)}</dd></div>
          <div><dt>路由记录</dt><dd><RouteStatus agent={data.agent} now={now} /></dd></div>
          <div><dt>实时采样</dt><dd>未接入</dd></div><div><dt>最近采样时间</dt><dd>{time(data.live.sampledAt)}</dd></div></dl>
        <div className="monitor-metrics">
          {([['已记录调用', number(data.usage.summary.calls), '次'], ['已记录 Token', number(data.usage.summary.tokens), 'Token'],
            ['已记录失败', number(data.usage.summary.failedCalls), '次'], ['样本延迟均值', number(data.usage.summary.avgLatencyMs), 'ms']] as const).map(([label, value, unit]) =>
            <div className="monitor-metric" key={label}><span>{label}</span><strong>{value}<small>{value !== '--' && unit}</small></strong></div>)}
        </div>
        <dl className="monitor-runtime"><div><dt><Cpu />CPU 使用率</dt><dd>未采集</dd></div><div><dt><Database />内存用量</dt><dd>未采集</dd></div>
          <div><dt>延迟样本</dt><dd>{number(data.usage.summary.latencySamples)}</dd></div><div><dt>数据完整性</dt><dd>仅含已入库事件</dd></div></dl>
        <header className="monitor-history-heading"><h3>历史用量</h3><span>Asia/Shanghai · 最近事件 {time(data.usage.lastRecordedAt)}</span></header>
        {data.usage.series.length === 0 ? <div className="monitor-empty"><Activity /><h3>此时间段暂无用量记录</h3></div>
          : <div className="monitor-table-scroll"><table className="monitor-table" aria-label="Agent 历史用量"><thead><tr><th>日期</th><th>调用</th><th>失败</th><th>Token</th><th>延迟样本</th><th>平均延迟 / ms</th></tr></thead>
            <tbody>{data.usage.series.map(item => <tr key={item.day}><td>{item.day}</td><td>{number(item.calls)}</td><td>{number(item.failedCalls)}</td><td>{number(item.tokens)}</td><td>{number(item.latencySamples)}</td><td>{number(item.avgLatencyMs)}</td></tr>)}</tbody></table></div>}
      </>}
    </section>}
  </div>;
}
