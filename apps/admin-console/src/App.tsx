import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Bot, ChevronLeft, ChevronRight, CircleAlert, LogOut, RefreshCw, Search, Server, ShieldCheck, Users } from 'lucide-react';
import { AdminSession } from './session';
import { InfrastructureView } from './InfrastructureView';
import { GovernanceDialog, accountLabels } from './GovernanceDialog';
import type { Query, Row, View } from './session';

const model = new AdminSession();
const labels: Record<string, string> = { uninitialized: '未初始化', provisioning: '准备中', starting: '启动中', ready: '就绪', degraded: '降级', offline: '离线', failed: '失败', stopped: '已停止' };
const roles: Record<string, string> = { platform_viewer: '平台观察员', platform_operator: '平台运维员', platform_admin: '平台管理员' };
const date = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无记录';

function Login({ error, query }: { error: string; query: Query }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); const secret = password; setPassword(''); void model.signIn(email.trim(), secret, query); };
  return <main className="access"><div className="access-inner">
    <ShieldCheck size={32} className="brand-icon" /><h1>百睿云管理端</h1>
    <form onSubmit={submit} className="login-form">
      <label>邮箱<input type="email" autoComplete="username" required maxLength={200} value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label>密码<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e => setPassword(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" type="submit">登录 <ArrowRight size={16} /></button>
    </form><a href="/" className="back-link"><ArrowLeft size={16} /> 返回客户端</a>
  </div></main>;
}

function UserRow({ row, showAgents }: { row: Row; showAgents: (id: string) => void }) {
  return <tr><td><strong>{row.displayName || row.email}</strong><span className="subtext">{row.email}</span></td>
    <td><code>{row.id}</code></td><td><span className={'badge ' + (row.authLinked ? 'positive' : '')}>{row.authLinked ? '已接入' : '未接入'}</span></td>
    <td><span className={'badge ' + (row.account?.status === 'active' ? 'positive' : 'negative')}>{accountLabels[row.account?.status || ''] || '待确认'}</span></td>
    <td className="date">{date(row.createdAt)}</td><td><div className="row-actions"><button className="row-action" title="查看该用户的 Agent" aria-label={'查看 ' + row.email + ' 的 Agent'} onClick={() => showAgents(row.id)}><Bot size={17} /><ChevronRight size={14} /></button><button className="row-action" title="账号治理与记录" aria-label={'治理 ' + row.email} onClick={() => void model.openGovernance(row)}><ShieldCheck size={18} /></button></div></td></tr>;
}
function AgentRow({ row }: { row: Row }) {
  return <tr><td><strong>{row.name}</strong><code className="subtext">{row.id}</code></td><td><span>{row.ownerEmail}</span><code className="subtext">{row.ownerUserId}</code></td>
    <td><span className={'badge ' + (row.status === 'failed' ? 'negative' : '')}>{labels[row.status || ''] || row.status}</span></td><td>{row.engine}</td><td className="date">{date(row.updatedAt || row.createdAt)}</td></tr>;
}

export function App() {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [query, setQuery] = useState<Query>({ view: 'users', limit: '25' });
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const view = query.view;
  const title = view === 'users' ? '用户账号' : view === 'agents' ? 'Agent 服务' : '服务器资源';
  useEffect(() => { void model.load(query); return model.cancel; }, [query]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && model.getSnapshot().phase === 'ready' && !model.getSnapshot().governance) void model.load(query); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 60000);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [query]);
  const reset = (next: Query) => { setHistory([]); setQuery({ limit: '25', ...next, after: '' }); };
  const switchView = (next: View) => { setDraft(''); reset({ view: next }); };
  const signOut = () => { setDraft(''); setHistory([]); void model.signOut(); setQuery({ view: 'users', limit: '25' }); };
  const pageBack = () => { setQuery({ ...query, after: history.at(-1) || '' }); setHistory(history.slice(0, -1)); };
  const pageNext = () => { if (state.nextCursor) { setHistory([...history, query.after || '']); setQuery({ ...query, after: state.nextCursor }); } };

  if (state.phase === 'login') return <Login error={state.error} query={query} />;
  if (['denied', 'error', 'logout-error'].includes(state.phase)) return <main className="access"><div className="access-inner">
    <CircleAlert size={32} className="warning-icon" /><h1>{state.phase === 'denied' ? '无管理端访问权限' : state.phase === 'logout-error' ? '退出尚未完成' : '管理端暂不可用'}</h1>
    <p role="alert">{state.error}</p><div className="access-actions">
      {state.phase !== 'logout-error' && <button onClick={() => void model.load(query)}><RefreshCw size={16} /> 重试</button>}
      <button onClick={signOut}><LogOut size={16} /> {state.phase === 'logout-error' ? '重试退出' : '退出账号'}</button>
    </div><a href="/" className="back-link"><ArrowLeft size={16} /> 返回客户端</a></div></main>;

  const busy = state.phase !== 'ready';
  return <div className="admin-layout">
    <aside className="sidebar">
      <div className="brand"><ShieldCheck size={27} /><div><strong>百睿云</strong><span>管理端</span></div></div>
      <nav aria-label="管理端导航"><button aria-current={view === 'users' ? 'page' : undefined} onClick={() => switchView('users')}><Users size={18} /> 用户账号</button>
        <button aria-current={view === 'agents' ? 'page' : undefined} onClick={() => switchView('agents')}><Bot size={18} /> Agent 服务</button>
        <button aria-current={view === 'infrastructure' ? 'page' : undefined} onClick={() => switchView('infrastructure')}><Server size={18} /> 服务器资源</button></nav>
      <a className="client-link" href="/"><ArrowLeft size={16} /> 客户端</a>
    </aside>
    <div className="workspace"><header className="topbar"><span className="topbar-label">平台管理</span><div className="identity">
      {state.me && <><span className="role-label">{roles[state.me.role]}</span><span className="account" title={state.me.user.email}>{state.me.user.email}</span></>}
      <button className="icon-button" title="退出账号" aria-label="退出账号" disabled={state.phase === 'signing-out'} onClick={signOut}><LogOut size={18} /></button>
    </div></header>
    <main className="content" aria-busy={busy}>
      <div className="page-heading"><div><div className="breadcrumb">平台 / {title}</div><h1>{title}</h1></div><span className="read-label">{view === 'users' && state.me?.permissions.includes('users:govern') ? '账号治理' : '只读'}</span></div>
      {view === 'infrastructure' ? <InfrastructureView data={state.infrastructure} busy={busy} updatedAt={state.updatedAt} refresh={() => void model.load(query)} /> : <>
      <form className="toolbar" onSubmit={e => { e.preventDefault(); reset({ ...query, q: draft.trim() }); }}>
        <div className="search-field"><Search size={17} /><input aria-label="搜索" maxLength={200} placeholder={view === 'users' ? '搜索邮箱、名称或用户 ID' : '搜索名称、邮箱或 Agent ID'} value={draft} onChange={e => setDraft(e.target.value)} /><button type="submit" className="icon-button" aria-label="执行搜索" title="搜索"><ArrowRight size={16} /></button></div>
        {view === 'agents' && <select aria-label="记录状态" value={query.status || ''} onChange={e => reset({ ...query, status: e.target.value })}><option value="">全部记录状态</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>}
        <div className="toolbar-end"><span className="updated">{state.updatedAt ? '更新于 ' + new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</span><button type="button" className="icon-button" title="刷新" aria-label="刷新" disabled={busy} onClick={() => void model.load(query)}><RefreshCw size={17} className={busy ? 'spin' : ''} /></button></div>
      </form>
      {query.ownerUserId && <div className="filter-line"><span>用户 ID：<code>{query.ownerUserId}</code></span><button onClick={() => reset({ ...query, ownerUserId: '' })}>清除筛选</button></div>}
      <div className="table-scroll"><table><thead>{view === 'users' ? <tr><th>账号</th><th>用户 ID</th><th>认证身份</th><th>账号状态</th><th>创建时间</th><th className="action-column">操作</th></tr> : <tr><th>Agent</th><th>所属用户</th><th>记录状态</th><th>引擎</th><th>记录更新时间</th></tr>}</thead>
        <tbody>{!busy && state.items.map(row => view === 'users' ? <UserRow key={row.id} row={row} showAgents={id => { setDraft(''); reset({ view: 'agents', ownerUserId: id }); }} /> : <AgentRow key={row.id} row={row} />)}
          {(busy || state.items.length === 0) && <tr><td colSpan={view === 'users' ? 6 : 5}><div className="empty" role="status">{busy ? <RefreshCw className="spin" size={24} /> : view === 'users' ? <Users size={28} /> : <Bot size={28} />}<span>{state.phase === 'signing-out' ? '正在退出' : busy ? '正在读取' : '暂无记录'}</span></div></td></tr>}
        </tbody></table></div>
      <footer className="pagination"><span>本页 {state.items.length} 条</span><div><label>每页 <select aria-label="每页条数" value={query.limit} onChange={e => reset({ ...query, limit: e.target.value })}>{['25', '50', '100'].map(n => <option key={n}>{n}</option>)}</select> 条</label><button className="icon-button" title="上一页" aria-label="上一页" disabled={busy || !history.length} onClick={pageBack}><ChevronLeft size={18} /></button><span className="page-number">{history.length + 1}</span><button className="icon-button" title="下一页" aria-label="下一页" disabled={busy || !state.nextCursor} onClick={pageNext}><ChevronRight size={18} /></button></div></footer>
      </>}
    </main></div>{state.governance && <GovernanceDialog key={state.governance.target.id} model={model} value={state.governance} canGovern={Boolean(state.me?.permissions.includes('users:govern') && state.me.user.id !== state.governance.target.id)} />}</div>;
}
