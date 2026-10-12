import { Activity, Archive, BarChart3, Bell, BookOpen, Bot, CheckCircle2, CircleAlert, Clock3, FileCheck2, LayoutDashboard, LibraryBig, LoaderCircle, LogOut, MessageSquare, Plus, Puzzle, RefreshCw, Search, Send, Settings, Settings2, ShieldCheck, Sparkles, Star, Terminal, Trash2, Users, Wallet, Wrench, X, Zap } from 'lucide-react';
import type { FormEvent, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CLOSED_CAPABILITIES, fetchCapabilities, type PlatformCapabilities, addFavorite, createAgent, createFiling, createResource, createSession, deleteResource, fetchAccount, fetchAgents, fetchCurrentUser, fetchFavorites, fetchFilings, fetchHealth, fetchNotifications, fetchResource, fetchResources, fetchSettings, fetchTransactions, fetchUsage, logoutAccount, markNotificationRead, readAllNotifications, rechargeAccount, removeFavorite, streamChat, updateResource, updateSettings, type AccountInfo, type BackendAgent, type BackendNotification, type BackendResource, type BillingTransaction, type FavoriteItem, type FilingRecord, type ResourceDetail, type ResourceKind, type Session, type UsagePayload, type User, type UserSettings } from './api';
import { LoginPage } from './LoginPage';
import { ClientMonitoring } from './ClientMonitoring';

type LibraryPanel = 'library' | 'library-knowledge_base' | 'library-skill' | 'library-tool' | 'library-plugin';
type Panel = 'overview' | LibraryPanel | 'agents' | 'chat' | 'conversations' | 'deploy' | 'control' | 'approvals' | 'observability' | 'favorites' | 'billing' | 'filing';
type AgentTab = 'templates' | 'projects' | 'runs' | 'settings';
type ResourceTab = 'all' | ResourceKind;
type ChatMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string; time: string };
const statusCopy = { ready: { label: '运行中', tone: 'ready' }, provisioning: { label: '部署中', tone: 'pending' } } as const;
const engineLabels: Record<string, string> = { mock: '模拟 Runtime', pi: 'Pi 引擎', dsh: 'DeepSeek 引擎' };
const engineLabel = (agent: BackendAgent) => (agent.engine ? (engineLabels[agent.engine] ?? agent.engine) : agent.runtimeKind ? (engineLabels[agent.runtimeKind] ?? agent.runtimeKind) : '模拟 Runtime');
const clock = () => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date());
const formatTime = (value?: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '';
const templateItems: Array<{ name: string; description: string; tags: string[]; tone: string; icon: typeof Bot }> = [
  { name: '客服助手', description: '多轮对话、工单流转与人工转接，支持企业知识库检索。', tags: ['RAG', '多渠道'], tone: 'blue', icon: MessageSquare },
  { name: '数据分析 Copilot', description: '连接数据源，用自然语言生成 SQL 与图表。', tags: ['SQL', 'Tool'], tone: 'violet', icon: BarChart3 },
  { name: '内容创作 Agent', description: '文案撰写、AIGC 配图、多语言翻译与 SEO 优化。', tags: ['AIGC'], tone: 'orange', icon: Zap },
  { name: '代码审查助手', description: '接入代码仓库，自动扫描风险并生成审查意见。', tags: ['DevOps'], tone: 'green', icon: Terminal },
  { name: 'HR 招聘助理', description: '职位发布、简历解析、面试邀约与候选人评分。', tags: ['HR', 'RAG'], tone: 'cyan', icon: Users },
  { name: '运维 SRE Copilot', description: '聚合告警、定位根因，并辅助执行 Runbook。', tags: ['SRE', 'Tool'], tone: 'red', icon: Settings2 },
];
const roleLabel = (role: string | undefined) => ({ admin: '管理员', owner: '所有者', org_admin: '组织管理员', developer: '开发者' } as Record<string, string>)[role ?? ''] ?? '用户';
const RESOURCE_KIND_LABEL = { knowledge_base: '知识库', skill: 'Skill', tool: '工具', plugin: '插件' } as const;
const RESOURCE_KIND_ICON = { knowledge_base: BookOpen, skill: Sparkles, tool: Wrench, plugin: Puzzle } as const;

const CapabilitiesContext = createContext<PlatformCapabilities>(CLOSED_CAPABILITIES);
const capabilityNotice = '当前未开放 Agent 执行与充值';

export function App() {
  const [capabilities, setCapabilities] = useState(CLOSED_CAPABILITIES);
  const [user, setUser] = useState<User | null>(null);
  const [agents, setAgents] = useState<BackendAgent[]>([]);
  const [resources, setResources] = useState<BackendResource[]>([]);
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [panel, setPanel] = useState<Panel>('overview');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [agentsEntry, setAgentsEntry] = useState<AgentTab>('templates');
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentEngine, setAgentEngine] = useState<'mock' | 'pi' | 'dsh'>('mock');
  const [modal, setModal] = useState(false);
  const [resourceModal, setResourceModal] = useState(false);
  const [resourceKind, setResourceKind] = useState<ResourceKind>('knowledge_base');
  const [resourceName, setResourceName] = useState('');
  const [resourceDescription, setResourceDescription] = useState('');
  const [resourceContent, setResourceContent] = useState('');
  const [resourceDetail, setResourceDetail] = useState<ResourceDetail | null>(null);
  const [resourceBusy, setResourceBusy] = useState(false);
  const [health, setHealth] = useState<'postgres' | 'memory' | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const [notifications, setNotifications] = useState<BackendNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [transactions, setTransactions] = useState<BillingTransaction[]>([]);
  const [filings, setFilings] = useState<FilingRecord[]>([]);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filingOpen, setFilingOpen] = useState(false);
  const sessionGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const clearUserSession = useCallback(() => {
    sessionGeneration.current++;
    refreshGeneration.current++;
    setCapabilities(CLOSED_CAPABILITIES);
    setUser(null); setAgents([]); setResources([]); setUsage(null); setSelectedId(null);
    setSession(null); setMessages([]); setText(''); setPanel('overview');
    setFavorites([]); setNotifications([]); setUnread(0); setSettings(null);
    setAccount(null); setTransactions([]); setFilings([]); setResourceDetail(null);
    setModal(false); setResourceModal(false); setNoticeOpen(false); setSettingsOpen(false);
    setFilingOpen(false); setRefreshing(false); setError(null);
  }, []);
  useEffect(() => {
    window.addEventListener('bairui:session-expired', clearUserSession);
    return () => window.removeEventListener('bairui:session-expired', clearUserSession);
  }, [clearUserSession]);
  useEffect(() => {
    if (!user?.userId) return;
    let cancelled = false, pending = false;
    const controller = new AbortController();
    const generation = sessionGeneration.current;
    const check = async () => {
      if (pending || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const next = await fetchCurrentUser(AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
        if (!cancelled && generation === sessionGeneration.current && next?.userId === user.userId) setUser(next);
      } catch { /* The server continues to enforce access while polling is unavailable. */ }
      finally { pending = false; }
    };
    const timer = window.setInterval(() => void check(), 30000);
    window.addEventListener('focus', check);
    window.addEventListener('bairui:account-refresh', check);
    document.addEventListener('visibilitychange', check);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); window.removeEventListener('focus', check); window.removeEventListener('bairui:account-refresh', check); document.removeEventListener('visibilitychange', check); };
  }, [user?.userId]);
  const agent = useMemo(() => agents.find((item) => item.id === selectedId) ?? null, [agents, selectedId]);
  const activeResources = useMemo(() => resources.filter((item) => item.status === 'active').length, [resources]);
  const resourceCounts = useMemo(() => {
    const byKind = (kind: string) => resources.filter((item) => item.kind === kind).length;
    return { knowledge_base: byKind('knowledge_base'), skill: byKind('skill'), tool: byKind('tool'), plugin: byKind('plugin') };
  }, [resources]);
  const refresh = useCallback(async () => {
    const generation = sessionGeneration.current;
    const refreshId = ++refreshGeneration.current;
    const isCurrent = () => generation === sessionGeneration.current && refreshId === refreshGeneration.current;
    setRefreshing(true);
    setCapabilities(CLOSED_CAPABILITIES);
    try {
      const [nextAgents, nextResources, nextUsage, nextCapabilities] = await Promise.all([fetchAgents(), fetchResources(), fetchUsage('today'), fetchCapabilities()]);
      if (!isCurrent()) return;
      setAgents(nextAgents); setResources(nextResources); setUsage(nextUsage);
      setSelectedId((id) => id && nextAgents.some((item) => item.id === id) ? id : nextAgents[0]?.id ?? null);
      const [nextFavorites, nextNotices, nextSettings, nextAccount, nextTransactions, nextFilings] = await Promise.all([
        fetchFavorites().catch(() => []),
        fetchNotifications().catch(() => ({ notifications: [], unreadCount: 0 })),
        fetchSettings().catch(() => null),
        fetchAccount().catch(() => null),
        fetchTransactions().catch(() => []),
        fetchFilings().catch(() => []),
      ]);
      if (!isCurrent()) return;
      setCapabilities(nextCapabilities);
      setFavorites(nextFavorites); setNotifications(nextNotices.notifications); setUnread(nextNotices.unreadCount);
      setSettings(nextSettings); setAccount(nextAccount); setTransactions(nextTransactions); setFilings(nextFilings);
      setError(null);
    } catch (caught) { if (isCurrent()) setError(caught instanceof Error ? caught.message : '加载控制台数据失败'); }
    finally { if (isCurrent()) setRefreshing(false); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => { try { const current = await fetchCurrentUser(); if (!cancelled) { setUser(current); if (current) await refresh(); } } catch (caught) { if (!cancelled) setError(caught instanceof Error ? caught.message : '无法连接平台 API'); } finally { if (!cancelled) setLoading(false); } })();
    void fetchHealth().then(({ database }) => { if (!cancelled) setHealth(database === 'postgres' ? 'postgres' : 'memory'); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [refresh]);
  useEffect(() => { if (!capabilities.agentExecution || !agents.some((item) => item.status === 'provisioning')) return undefined; const timer = window.setInterval(() => void refresh(), 2000); return () => window.clearInterval(timer); }, [agents, refresh, capabilities.agentExecution]);
  const handleAuthenticated = useCallback(async (next: User) => { clearUserSession(); setUser(next); await refresh(); }, [refresh, clearUserSession]);
  async function handleLogout() {
    try { await logoutAccount(); clearUserSession(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '退出失败，请重试'); }
  }
  async function submitAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!capabilities.agentLifecycle) return; const name = agentName.trim(); if (!name) return;
    try { const created = await createAgent(name, agentEngine); setAgentName(''); setModal(false); setSelectedId(created.id); setPanel('agents'); await refresh(); } catch (caught) { setError(caught instanceof Error ? caught.message : '创建 Agent 失败'); }
  }
  async function submitResource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const name = resourceName.trim(); if (!name || resourceBusy) return;
    setResourceBusy(true);
    try {
      await createResource({ kind: resourceKind, name, description: resourceDescription.trim() || undefined, content: resourceContent.trim() || undefined });
      setResourceName(''); setResourceDescription(''); setResourceContent(''); setResourceModal(false); await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '创建资源失败'); } finally { setResourceBusy(false); }
  }
  async function openResourceDetail(item: BackendResource) {
    try { setResourceDetail(await fetchResource(item.id)); setError(null); } catch (caught) { setError(caught instanceof Error ? caught.message : '加载资源详情失败'); }
  }
  async function saveResourceContent(content: string) {
    if (!resourceDetail) return;
    try { await updateResource(resourceDetail.resource.id, { content: content.trim() || null }); setResourceDetail(null); await refresh(); } catch (caught) { setError(caught instanceof Error ? caught.message : '保存资源内容失败'); }
  }
  async function setResourceStatus(item: BackendResource, status: 'active' | 'archived') {
    try { await updateResource(item.id, { status }); await refresh(); } catch (caught) { setError(caught instanceof Error ? caught.message : '更新资源状态失败'); }
  }
  async function removeResource(item: BackendResource) {
    if (!window.confirm('确定删除资源「' + item.name + '」吗？删除后不可恢复。')) return;
    try { await deleteResource(item.id); await refresh(); } catch (caught) { setError(caught instanceof Error ? caught.message : '删除资源失败'); }
  }
  async function openChat(item: BackendAgent) {
    if (!capabilities.agentExecution) return;
    if (item.status !== 'ready') return;
    try { const next = await createSession(item.id, '新的工作对话'); setSelectedId(item.id); setSession(next); setMessages([{ id: 'welcome', role: 'system', content: '会话已建立，可以开始和模拟 Runtime 对话。', time: clock() }]); setPanel('chat'); setError(null); } catch (caught) { setError(caught instanceof Error ? caught.message : '创建会话失败'); }
  }
  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!capabilities.agentExecution || !text.trim() || !agent || !session || sending) return;
    const content = text.trim(); setText(''); setSending(true); setMessages((items) => [...items, { id: 'u-' + Date.now(), role: 'user', content, time: clock() }]);
    try { await streamChat(agent.id, session.id, content, (name, data) => { if (name === 'message.completed') setMessages((items) => [...items, { id: 'a-' + Date.now(), role: 'assistant', content: String(data.content || ''), time: clock() }]); if (name === 'run.failed') setError('Runtime 执行失败，请稍后重试'); }); await refresh(); } catch (caught) { setError(caught instanceof Error ? caught.message : '发送消息失败'); } finally { setSending(false); }
  }
  function openFavorite(item: FavoriteItem) {
    if (item.targetType === 'agent') { setSelectedId(item.targetId); setAgentsEntry('projects'); setPanel('agents'); }
    else setPanel('library');
  }
  async function removeOneFavorite(item: FavoriteItem) {
    try { await removeFavorite(item.id); setFavorites((list) => list.filter((favorite) => favorite.id !== item.id)); } catch (caught) { setError(caught instanceof Error ? caught.message : '取消收藏失败'); }
  }
  const favoriteKey = (type: 'agent' | 'resource', id: string) => favorites.some((item) => item.targetType === type && item.targetId === id);
  async function toggleAgentFavorite(agent: BackendAgent) {
    const existing = favorites.find((item) => item.targetType === 'agent' && item.targetId === agent.id);
    if (existing) return removeOneFavorite(existing);
    try { const favorite = await addFavorite('agent', agent.id); setFavorites((list) => [favorite, ...list.filter((item) => item.id !== favorite.id)]); } catch (caught) { setError(caught instanceof Error ? caught.message : '收藏失败'); }
  }
  async function toggleResourceFavorite(resource: BackendResource) {
    const existing = favorites.find((item) => item.targetType === 'resource' && item.targetId === resource.id);
    if (existing) return removeOneFavorite(existing);
    try { const favorite = await addFavorite('resource', resource.id); setFavorites((list) => [favorite, ...list.filter((item) => item.id !== favorite.id)]); } catch (caught) { setError(caught instanceof Error ? caught.message : '收藏失败'); }
  }
  async function markAllNotificationsRead() {
    try { await readAllNotifications(); setNotifications((list) => list.map((item) => ({ ...item, isRead: true }))); setUnread(0); } catch (caught) { setError(caught instanceof Error ? caught.message : '操作失败'); }
  }
  async function markOneNotificationRead(id: string) {
    try { await markNotificationRead(id); setNotifications((list) => list.map((item) => (item.id === id ? { ...item, isRead: true } : item))); setUnread((count) => Math.max(0, count - 1)); } catch { /* 忽略单条已读失败 */ }
  }
  async function saveSettings(displayName: string) {
    const next = await updateSettings({ displayName: displayName.trim() || null });
    setSettings(next); setSettingsOpen(false); setError(null);
  }
  async function topUp(amountCents: number) {
    if (!capabilities.simulatedRecharge) throw new Error(capabilityNotice);
    const result = await rechargeAccount(amountCents);
    setAccount(result.account); setTransactions((list) => [result.transaction, ...list]);
    try { const notices = await fetchNotifications(); setNotifications(notices.notifications); setUnread(notices.unreadCount); } catch { /* 忽略 */ }
  }
  async function submitFiling(input: { domain: string; subjectName: string; subjectType: 'enterprise' | 'individual'; icpNumber?: string }) {
    const filing = await createFiling(input);
    setFilings((list) => [filing, ...list]); setFilingOpen(false);
    try { const notices = await fetchNotifications(); setNotifications(notices.notifications); setUnread(notices.unreadCount); } catch { /* 忽略 */ }
  }
  if (loading) return <div className="console-loading"><LoaderCircle className="spin" /><span>正在连接 BaiRui 控制台...</span></div>;
  if (!user) return <LoginPage onAuthenticated={(next) => void handleAuthenticated(next)} />;
  return <CapabilitiesContext.Provider value={capabilities}><div className="console-app">
    {user.accountStatus === 'suspended' && <div className="account-restriction" role="status"><ShieldCheck size={18} /><span>账号服务已暂停，当前仅可查看本人历史数据。请联系支持人员处理。</span></div>}
    <header className="console-topbar">
      <div className="console-topbar-left">
        <div className="console-brand"><span className="console-mark">BR</span><div><strong>BaiRui</strong><small>Agent Cloud</small></div></div>
        <nav className="console-topbar-nav" aria-label="主导航">
          <button type="button" className={'console-topbar-link' + (panel === 'overview' ? ' active' : '')} onClick={() => setPanel('overview')}>控制台</button>
          <button type="button" className={'console-topbar-link' + (panel === 'favorites' ? ' active' : '')} title="我的收藏" onClick={() => setPanel('favorites')}>我的收藏</button>
        </nav>
      </div>
      <GlobalSearch agents={agents} resources={resources} onOpenAgent={(id) => { setSelectedId(id); setAgentsEntry('projects'); setPanel('agents'); }} onOpenResource={(kind) => setPanel('library-' + kind as LibraryPanel)} />
      <div className="console-topbar-right">
        <nav className="console-topbar-nav" aria-label="平台服务">
          <button type="button" className={'console-topbar-link' + (panel === 'filing' ? ' active' : '')} title="备案" onClick={() => setPanel('filing')}>备案</button>
          <button type="button" className={'console-topbar-link' + (panel === 'billing' ? ' active' : '')} title="费用" onClick={() => setPanel('billing')}>费用</button>
        </nav>
        <div className="console-top-actions">
          <button className={'icon-button' + (noticeOpen ? ' active' : '')} title="通知" aria-label="通知" onClick={() => setNoticeOpen((open) => !open)}><Bell />{unread > 0 ? <span className="bell-badge">{unread > 99 ? '99+' : unread}</span> : <i />}</button>
          <button className="icon-button" title="设置" aria-label="设置" onClick={() => setSettingsOpen(true)}><Settings /></button>
          <div className="console-user"><span className="console-avatar">{(user?.email?.charAt(0) ?? 'U').toUpperCase()}</span><div className="console-user-meta"><strong>{settings?.displayName || user?.email || '本地开发用户'}</strong><small><span className={'connection-dot' + (health === 'memory' ? ' warn' : '')} />{health === null ? '连接服务中' : health === 'postgres' ? 'PostgreSQL 已连接' : '内存模式（开发）'} · {roleLabel(user?.role)}</small></div></div>
          <button className="icon-button" title="刷新数据" aria-label="刷新数据" onClick={() => void refresh()}><RefreshCw className={refreshing ? 'spin' : ''} /></button>
          <button className="icon-button" title="退出登录" aria-label="退出登录" onClick={() => void handleLogout()}><LogOut /></button>
        </div>
      </div>
    </header>
    <div className="console-layout"><aside className="console-sidebar"><div className="sidebar-group"><div className="sidebar-section-label">工作台</div><Nav active={panel === 'overview'} icon={<LayoutDashboard />} onClick={() => setPanel('overview')}>总览</Nav><Nav active={panel === 'agents'} icon={<Bot />} onClick={() => { setAgentsEntry('templates'); setPanel('agents'); }}>智能体 Agents <span className="sidebar-count">{agents.length}</span></Nav><Nav active={panel === 'conversations' || panel === 'chat'} icon={<MessageSquare />} onClick={() => setPanel(session ? 'chat' : 'conversations')}>会话管理</Nav></div><div className="sidebar-group"><div className="sidebar-section-label">开发与部署</div><Nav active={panel === 'deploy'} icon={<Zap />} onClick={() => setPanel('deploy')}>部署发布</Nav><Nav active={panel === 'control'} icon={<Settings2 />} onClick={() => setPanel('control')}>运维控制</Nav><Nav active={panel === 'approvals'} icon={<FileCheck2 />} onClick={() => setPanel('approvals')}>审批中心</Nav><Nav active={panel === 'observability'} icon={<BarChart3 />} onClick={() => setPanel('observability')}>可观测</Nav></div><div className="sidebar-group"><Nav active={panel === 'library'} icon={<LibraryBig />} onClick={() => setPanel('library')}>资源库 <span className="sidebar-count">{resources.length}</span></Nav><Nav sub active={panel === 'library-knowledge_base'} icon={<BookOpen />} onClick={() => setPanel('library-knowledge_base')}>知识库 <span className="sidebar-count">{resourceCounts.knowledge_base}</span></Nav><Nav sub active={panel === 'library-skill'} icon={<Sparkles />} onClick={() => setPanel('library-skill')}>Skill <span className="sidebar-count">{resourceCounts.skill}</span></Nav><Nav sub active={panel === 'library-tool'} icon={<Wrench />} onClick={() => setPanel('library-tool')}>工具 <span className="sidebar-count">{resourceCounts.tool}</span></Nav><Nav sub active={panel === 'library-plugin'} icon={<Puzzle />} onClick={() => setPanel('library-plugin')}>插件 <span className="sidebar-count">{resourceCounts.plugin}</span></Nav></div></aside>
      <main className="console-main">{error && <div className="console-alert"><CircleAlert /><span>{error}</span><button className="icon-button" title="关闭提示" aria-label="关闭提示" onClick={() => setError(null)}><X /></button></div>}{panel === 'overview' && <Overview agents={agents} usage={usage} onCreate={() => setModal(true)} onAgents={() => setPanel('agents')} onChat={openChat} />}{panel.startsWith('library') && <ResourceLibrary initialTab={panel === 'library' ? 'all' : panel.replace('library-', '') as ResourceTab} resources={resources} favorites={favorites} onRefresh={() => void refresh()} onCreate={() => { setResourceKind(panel === 'library' ? 'knowledge_base' : panel.replace('library-', '') as ResourceKind); setResourceModal(true); }} onToggleStatus={(item) => void setResourceStatus(item, item.status === 'active' ? 'archived' : 'active')} onView={(item) => void openResourceDetail(item)} onDelete={(item) => void removeResource(item)} onToggleFavorite={(item) => void toggleResourceFavorite(item)} />}{panel === 'agents' && <Agents agents={agents} selectedId={selectedId} entryTab={agentsEntry} favorites={favorites} onSelect={setSelectedId} onCreate={() => setModal(true)} onChat={openChat} onRefresh={() => void refresh()} onCreateFromTemplate={(name) => { setAgentName(name); setModal(true); }} onToggleFavorite={(agent) => void toggleAgentFavorite(agent)} />}{panel === 'chat' && agent && session && <Chat agent={agent} session={session} messages={messages} text={text} sending={sending} onText={setText} onSubmit={submitMessage} onBack={() => setPanel('agents')} />}{panel === 'conversations' && <PlaceholderPanel title="会话管理" description="查看当前用户下各 Agent 的会话记录。会话详情已可从 Agent 页面进入。" icon={<MessageSquare />} onNavigate={() => setPanel('agents')} action="进入我的 Agents" />}{panel === 'deploy' && <PlaceholderPanel title="部署发布" description={capabilities.agentExecution ? '本地开发部署记录' : 'Agent 部署暂未开放'} icon={<Zap />} onNavigate={() => setPanel('agents')} action="查看 Agent 状态" />}{panel === 'control' && <PlaceholderPanel title="运维控制" description="运维命令、状态漂移与执行回执将在控制面接口接入后开放。" icon={<Settings2 />} onNavigate={() => setPanel('overview')} action="返回工作台" />}{panel === 'approvals' && <PlaceholderPanel title="审批中心" description="需要审批的高风险操作将在后续权限与审计模块接入后显示。" icon={<FileCheck2 />} onNavigate={() => setPanel('overview')} action="返回工作台" />}{panel === 'observability' && <ClientMonitoring key={user.userId + ':' + user.organizationId} />}{panel === 'favorites' && <FavoritesPanel favorites={favorites} onOpen={openFavorite} onRemove={(item) => void removeOneFavorite(item)} onGoCreateAgent={() => setModal(true)} onGoLibrary={() => setPanel('library')} />}{panel === 'billing' && <BillingPanel account={account} transactions={transactions} onTopUp={topUp} />}{panel === 'filing' && <FilingPanel filings={filings} onCreate={() => setFilingOpen(true)} onRefresh={() => void refresh()} />}</main>
    </div>{modal && capabilities.agentLifecycle && <CreateModal name={agentName} engine={agentEngine} onName={setAgentName} onEngine={setAgentEngine} onSubmit={submitAgent} onClose={() => setModal(false)} />}{resourceModal && <CreateResourceModal kind={resourceKind} name={resourceName} description={resourceDescription} content={resourceContent} busy={resourceBusy} onKind={setResourceKind} onName={setResourceName} onDescription={setResourceDescription} onContent={setResourceContent} onSubmit={submitResource} onClose={() => setResourceModal(false)} />}{resourceDetail && <ResourceDetailModal detail={resourceDetail} onClose={() => setResourceDetail(null)} onSave={(content) => void saveResourceContent(content)} />}{noticeOpen && <><div className="pop-layer" onClick={() => setNoticeOpen(false)} /><div className="notice-pop"><div className="notice-pop-head"><strong>通知中心</strong><button type="button" className="text-button" onClick={() => void markAllNotificationsRead()}>全部已读</button></div><div className="notice-pop-list">{notifications.length === 0 ? <div className="search-empty">暂无通知</div> : notifications.slice(0, 12).map((item) => <button key={item.id} type="button" className={'notice-item' + (item.isRead ? ' read' : '')} onClick={() => void markOneNotificationRead(item.id)}><span className="notice-icon"><Bell /></span><span className="notice-main"><strong>{item.title}</strong><p>{item.body}</p><small>{formatTime(item.createdAt)}</small></span>{!item.isRead && <i />}</button>)}</div></div></>}{settingsOpen && <SettingsModal displayName={settings?.displayName ?? null} onSubmit={saveSettings} onClose={() => setSettingsOpen(false)} />}{filingOpen && <FilingModal onSubmit={submitFiling} onClose={() => setFilingOpen(false)} />}
  </div></CapabilitiesContext.Provider>;
}
function GlobalSearch({ agents, resources, onOpenAgent, onOpenResource }: { agents: BackendAgent[]; resources: BackendResource[]; onOpenAgent: (id: string) => void; onOpenResource: (kind: ResourceKind) => void }) { const capabilities = useContext(CapabilitiesContext);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const q = query.trim().toLowerCase();
  const agentHits = q ? agents.filter((item) => (item.name + ' ' + item.id).toLowerCase().includes(q)).slice(0, 6) : [];
  const resourceHits = q ? resources.filter((item) => ((item.name || '') + ' ' + (item.description || '') + ' ' + (RESOURCE_KIND_LABEL[item.kind] || '')).toLowerCase().includes(q)).slice(0, 6) : [];
  const hasHit = agentHits.length > 0 || resourceHits.length > 0;
  const close = () => setOpen(false);
  const choose = (run: () => void) => { run(); setQuery(''); close(); };
  return <div className="console-search-wrap"><div className="console-search"><Search /><input value={query} aria-label="搜索 Agent 与资源" placeholder="搜索我的 Agent、资源…" onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(close, 120)} /></div>{open && q && <div className="console-search-pop">{!hasHit ? <div className="search-empty">没有找到与「{query.trim()}」匹配的 Agent 或资源</div> : <>{agentHits.length > 0 && <div className="search-group-label">智能体 Agents</div>}{agentHits.map((item) => <button key={'agent-' + item.id} type="button" className="search-item" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(() => onOpenAgent(item.id))}><Bot /><span><strong>{item.name}</strong><small>{item.id}</small></span><span className="search-kind">{!capabilities.agentExecution ? '历史记录' : item.status === 'ready' ? '运行中' : '部署中'}</span></button>)}{resourceHits.length > 0 && <div className="search-group-label">客户端资源</div>}{resourceHits.map((item) => { const KindIcon = RESOURCE_KIND_ICON[item.kind]; return <button key={'resource-' + item.id} type="button" className="search-item" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(() => onOpenResource(item.kind))}><KindIcon /><span><strong>{item.name}</strong><small>{item.description || item.id}</small></span><span className="search-kind">{RESOURCE_KIND_LABEL[item.kind]}</span></button>; })}</>}</div>}</div>;
}
function Nav({ active, disabled, icon, onClick, sub, children }: { active: boolean; disabled?: boolean; icon: ReactNode; onClick: () => void; sub?: boolean; children: ReactNode }) { return <button className={'sidebar-link ' + (active ? 'active ' : '') + (sub ? 'sidebar-sublink' : '')} disabled={disabled} onClick={onClick}>{icon}{children}</button>; }
function PlaceholderPanel({ title, description, icon, action, onNavigate }: { title: string; description: string; icon: ReactNode; action: string; onNavigate: () => void }) { return <div className="page-stack"><section className="placeholder-panel"><span className="placeholder-icon">{icon}</span><span className="eyebrow">功能入口已恢复</span><h1>{title}</h1><p>{description}</p><button className="button secondary" onClick={onNavigate}>{action}</button></section></div>; }
function CreateModal({ name, engine, onName, onEngine, onSubmit, onClose }: { name: string; engine: 'mock' | 'pi' | 'dsh'; onName: (value: string) => void; onEngine: (value: 'mock' | 'pi' | 'dsh') => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onClose: () => void }) { return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true"><header><div><span className="modal-icon"><Bot /></span><div><h2>创建 Agent</h2><p>创建后由 Worker 自动准备运行环境</p></div></div><button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X /></button></header><form onSubmit={onSubmit}><label>Agent 名称<input autoFocus value={name} onChange={(event) => onName(event.target.value)} placeholder="例如：客户服务助手" /></label><label>运行引擎</label><div className="kind-picker"><button type="button" className={engine === 'mock' ? 'active' : ''} onClick={() => onEngine('mock')}>模拟 Runtime</button><button type="button" className={engine === 'pi' ? 'active' : ''} onClick={() => onEngine('pi')}>Pi 引擎</button><button type="button" className={engine === 'dsh' ? 'active' : ''} onClick={() => onEngine('dsh')}>DeepSeek 引擎</button></div><p className="form-hint">引擎未接入真实运行时（镜像/密钥未配置）时由 Worker 自动回退到模拟 Runtime，Agent 就绪后即可创建会话。</p><footer><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={!name.trim()}><Plus />创建 Agent</button></footer></form></section></div>; }
function CreateResourceModal({ kind, name, description, content, busy, onKind, onName, onDescription, onContent, onSubmit, onClose }: { kind: ResourceKind; name: string; description: string; content: string; busy: boolean; onKind: (value: ResourceKind) => void; onName: (value: string) => void; onDescription: (value: string) => void; onContent: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onClose: () => void }) { return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true"><header><div><span className="modal-icon"><LibraryBig /></span><div><h2>新建资源</h2><p>保存到当前个人空间</p></div></div><button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X /></button></header><form onSubmit={onSubmit}><label>资源类型</label><div className="kind-picker"><button type="button" className={kind === 'knowledge_base' ? 'active' : ''} onClick={() => onKind('knowledge_base')}><BookOpen />知识库</button><button type="button" className={kind === 'skill' ? 'active' : ''} onClick={() => onKind('skill')}><Sparkles />Skill</button><button type="button" className={kind === 'tool' ? 'active' : ''} onClick={() => onKind('tool')}><Wrench />工具</button><button type="button" className={kind === 'plugin' ? 'active' : ''} onClick={() => onKind('plugin')}><Puzzle />插件</button></div><label>资源名称<input autoFocus value={name} onChange={(event) => onName(event.target.value)} placeholder={kind === 'knowledge_base' ? '例如：客服话术知识库' : kind === 'skill' ? '例如：数据查询 Skill' : kind === 'tool' ? '例如：订单物流查询工具' : '例如：企业微信通知插件'} /></label><label>描述<textarea rows={3} value={description} onChange={(event) => onDescription(event.target.value)} placeholder="一句话说明该资源的用途与内容范围（可选）" /></label><label>内容正文<textarea rows={6} value={content} onChange={(event) => onContent(event.target.value)} placeholder="粘贴知识文档、Skill 定义、工具说明或插件描述等资源正文（可选，持久化到 PostgreSQL）" /></label><p className="form-hint">创建后写入平台资源库（PostgreSQL 持久化），后续可挂载给 Agent 调用。</p><footer><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={!name.trim() || busy}>{busy ? <LoaderCircle className="spin" /> : <Plus />}创建资源</button></footer></form></section></div>; }
function Overview({ agents, usage, onCreate, onAgents, onChat }: { agents: BackendAgent[]; usage: UsagePayload | null; onCreate: () => void; onAgents: () => void; onChat: (agent: BackendAgent) => void }) { const capabilities = useContext(CapabilitiesContext); const ready = agents.filter((item) => item.status === 'ready').length; return <div className="page-stack"><section className="page-heading"><div><span className="eyebrow">客户业务控制台</span><h1>欢迎回来</h1><p>{capabilities.agentExecution ? '我的 Agent 工作空间' : '个人工作空间'}</p></div><button className="button primary" disabled={!capabilities.agentLifecycle} title={!capabilities.agentLifecycle ? capabilityNotice : undefined} onClick={onCreate}><Plus />创建 Agent</button></section><section className="metric-grid"><Metric icon={Bot} label="我的 Agents" value={String(agents.length)} detail={capabilities.agentExecution ? ready + ' 个可用' : '历史记录'} /><Metric icon={Zap} label="今日 Token" value={String(usage?.summary.totalTokens ?? 0)} detail="来自当前用户" /><Metric icon={Activity} label="今日调用" value={String(usage?.summary.totalCalls ?? 0)} detail="成功请求" /><Metric icon={Users} label={capabilities.agentExecution ? '活跃 Agent' : '历史活跃 Agent'} value={String(usage?.summary.activeAgents ?? ready)} detail="当前用户范围" /></section><section className="section-heading"><div><h2>最近的 Agent</h2><p>仅显示当前用户拥有的资源</p></div><button className="text-button" onClick={onAgents}>查看全部 <Chevron /></button></section><div className="agent-grid">{agents.slice(0, 3).map((item) => <AgentCard key={item.id} agent={item} onChat={onChat} />)}{agents.length === 0 && <Empty onCreate={onCreate} />}</div></div>; }
function ResourceLibrary({ initialTab, resources, favorites, onRefresh, onCreate, onToggleStatus, onView, onDelete, onToggleFavorite }: { initialTab: ResourceTab; resources: BackendResource[]; favorites: FavoriteItem[]; onRefresh: () => void; onCreate: () => void; onToggleStatus: (resource: BackendResource) => void; onView: (resource: BackendResource) => void; onDelete: (resource: BackendResource) => void; onToggleFavorite: (resource: BackendResource) => void }) { const [tab, setTab] = useState<ResourceTab>(initialTab); useEffect(() => setTab(initialTab), [initialTab]); const sameKind = (item: BackendResource, kind: string) => (item.kind as string) === kind; const counts = { knowledge_base: resources.filter((item) => sameKind(item, 'knowledge_base')).length, skill: resources.filter((item) => sameKind(item, 'skill')).length, tool: resources.filter((item) => sameKind(item, 'tool')).length, plugin: resources.filter((item) => sameKind(item, 'plugin')).length }; const visible = tab === 'all' ? resources : resources.filter((item) => sameKind(item, tab)); const emptyType = tab === 'knowledge_base' ? '知识库' : tab === 'skill' ? 'Skill' : tab === 'tool' ? '工具' : tab === 'plugin' ? '插件' : '客户端业务资源'; return <div className="page-stack resource-library"><section className="page-heading"><div><span className="eyebrow">客户端资源中心</span><h1>资源库</h1><p>知识库、Skill、工具与插件</p></div><div className="heading-actions"><button className="button secondary" onClick={onRefresh}><RefreshCw />刷新</button><button className="button primary" onClick={onCreate}><Plus />新建资源</button></div></section><div className="agent-workspace-tabs" role="tablist" aria-label="资源类型"><button className={'workspace-tab ' + (tab === 'all' ? 'active' : '')} role="tab" aria-selected={tab === 'all'} onClick={() => setTab('all')}>全部 <span>{resources.length}</span></button><button className={'workspace-tab ' + (tab === 'knowledge_base' ? 'active' : '')} role="tab" aria-selected={tab === 'knowledge_base'} onClick={() => setTab('knowledge_base')}>知识库 <span>{counts.knowledge_base}</span></button><button className={'workspace-tab ' + (tab === 'skill' ? 'active' : '')} role="tab" aria-selected={tab === 'skill'} onClick={() => setTab('skill')}>Skill <span>{counts.skill}</span></button><button className={'workspace-tab ' + (tab === 'tool' ? 'active' : '')} role="tab" aria-selected={tab === 'tool'} onClick={() => setTab('tool')}>工具 <span>{counts.tool}</span></button><button className={'workspace-tab ' + (tab === 'plugin' ? 'active' : '')} role="tab" aria-selected={tab === 'plugin'} onClick={() => setTab('plugin')}>插件 <span>{counts.plugin}</span></button></div>{visible.length === 0 ? resources.length === 0 ? <ResourceEmpty onCreate={onCreate} /> : <section className="empty-state"><LibraryBig /><h3>该分类下暂无资源</h3><p>切换其他分类，或新建一个{emptyType}。</p><button className="button primary" onClick={onCreate}><Plus />新建资源</button></section> : <div className="agent-list resource-list">{visible.map((item) => <ResourceRow key={item.id} resource={item} favorite={favorites.some((favorite) => favorite.targetType === 'resource' && favorite.targetId === item.id)} onToggleStatus={() => onToggleStatus(item)} onView={() => onView(item)} onDelete={() => onDelete(item)} onToggleFavorite={() => onToggleFavorite(item)} />)}</div>}</div>; }
function ResourceRow({ resource, favorite, onToggleStatus, onView, onDelete, onToggleFavorite }: { resource: BackendResource; favorite: boolean; onToggleStatus: () => void; onView: () => void; onDelete: () => void; onToggleFavorite: () => void }) { const archived = resource.status === 'archived'; const kindMeta: Record<string, { icon: typeof Bot; label: string; tone: string }> = { knowledge_base: { icon: BookOpen, label: '知识库', tone: 'kb' }, skill: { icon: Sparkles, label: 'Skill', tone: 'skill' }, tool: { icon: Wrench, label: '工具', tone: 'tool' }, plugin: { icon: Puzzle, label: '插件', tone: 'plugin' } }; const meta = kindMeta[resource.kind] ?? kindMeta.skill; const KindIcon = meta.icon; return <div className={'resource-row' + (archived ? ' archived' : '')}><span className={'resource-icon ' + meta.tone}><KindIcon /></span><span className="resource-main"><strong>{resource.name}</strong><small title={resource.id}>{resource.description || resource.id}</small></span><span className={'resource-kind ' + meta.tone}>{meta.label}</span><span className={'status-pill ' + (archived ? 'pending' : 'ready')}>{archived ? <Archive /> : <CheckCircle2 />}{archived ? '已归档' : '使用中'}</span><span className="resource-actions"><button type="button" className={'text-button' + (favorite ? ' favorited' : '')} onClick={onToggleFavorite}><Star />{favorite ? '已收藏' : '收藏'}</button><button type="button" className="text-button" onClick={onView}><BookOpen />内容</button><button type="button" className="text-button" onClick={onToggleStatus}>{archived ? '恢复' : '归档'}</button><button type="button" className="text-button danger" onClick={onDelete}><Trash2 />删除</button></span></div>; }
function ResourceDetailModal({ detail, onClose, onSave }: { detail: ResourceDetail; onClose: () => void; onSave: (content: string) => void }) {
  const [content, setContent] = useState(detail.contentItems[0]?.content ?? '');
  const [saving, setSaving] = useState(false);
  const resource = detail.resource;
  const kindMeta = resource.kind === 'knowledge_base' ? { icon: BookOpen, label: '知识库' } : resource.kind === 'skill' ? { icon: Sparkles, label: 'Skill' } : resource.kind === 'tool' ? { icon: Wrench, label: '工具' } : { icon: Puzzle, label: '插件' };
  const KindIcon = kindMeta.icon;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true);
    try { await onSave(content); } finally { setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true"><header><div><span className="modal-icon"><KindIcon /></span><div><h2>{resource.name}</h2><p>{kindMeta.label} · {resource.id}</p></div></div><button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X /></button></header><form onSubmit={save}><div className="resource-detail-meta"><span className={'status-pill ' + (resource.status === 'archived' ? 'pending' : 'ready')}>{resource.status === 'archived' ? <Archive /> : <CheckCircle2 />}{resource.status === 'archived' ? '已归档' : '使用中'}</span>{resource.description ? <p>{resource.description}</p> : null}</div><label>内容正文<textarea rows={10} value={content} onChange={(event) => setContent(event.target.value)} placeholder="暂无内容正文，可在此输入后保存。" /></label><p className="form-hint">正文随资源持久化到 PostgreSQL，未来可检索并挂载给 Agent 使用；保存将整体替换当前内容。</p><footer><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={saving}>{saving ? <LoaderCircle className="spin" /> : <Plus />}保存内容</button></footer></form></section></div>;
}
function ResourceEmpty({ onCreate }: { onCreate: () => void }) { return <div className="empty-state"><LibraryBig /><h3>还没有业务资源</h3><p>创建知识库、Skill、工具或插件，为 Agent 提供检索知识与能力扩展。</p><button className="button primary" onClick={onCreate}><Plus />新建资源</button></div>; }
function TemplateGrid({ onCreateFromTemplate }: { onCreateFromTemplate: (name: string) => void }) { const capabilities = useContext(CapabilitiesContext); return <section className="template-grid agent-template-grid">{templateItems.map(({ name, description, tags, tone, icon: Icon }) => <button key={name} className="template-card" disabled={!capabilities.agentLifecycle} title={!capabilities.agentLifecycle ? capabilityNotice : undefined} onClick={() => onCreateFromTemplate(name)}><span className={'template-icon ' + tone}><Icon /></span><strong>{name}</strong><p>{description}</p><span className="template-meta">{tags.map((tag) => <i key={tag}>{tag}</i>)}</span><span className="template-use">{capabilities.agentLifecycle ? '使用模板' : '暂未开放'} <Chevron /></span></button>)}</section>; }
function Agents({ agents, selectedId, entryTab, favorites, onSelect, onCreate, onChat, onRefresh, onCreateFromTemplate, onToggleFavorite }: { agents: BackendAgent[]; selectedId: string | null; entryTab: AgentTab; favorites: FavoriteItem[]; onSelect: (id: string) => void; onCreate: () => void; onChat: (agent: BackendAgent) => void; onRefresh: () => void; onCreateFromTemplate: (name: string) => void; onToggleFavorite: (agent: BackendAgent) => void }) { const capabilities = useContext(CapabilitiesContext);
  const [tab, setTab] = useState<AgentTab>(entryTab);
  useEffect(() => setTab(entryTab), [entryTab]);
  return <div className="page-stack agent-workspace">
    <section className="page-heading"><div><span className="eyebrow">智能体工作区</span><h1>智能体 Agents</h1><p>{capabilities.agentLifecycle ? '从模板快速开始，或管理当前用户自己的 Agent 项目。' : 'Agent 创建与执行暂未开放'}</p></div><div className="heading-actions"><button className="button secondary" onClick={onRefresh}><RefreshCw />刷新</button><button className="button primary" disabled={!capabilities.agentLifecycle} title={!capabilities.agentLifecycle ? capabilityNotice : undefined} onClick={onCreate}><Plus />创建 Agent</button></div></section>
    <div className="agent-workspace-tabs" role="tablist" aria-label="智能体工作区">
      <button className={'workspace-tab ' + (tab === 'templates' ? 'active' : '')} role="tab" aria-selected={tab === 'templates'} onClick={() => setTab('templates')}>快速开始 <span>{templateItems.length}</span></button>
      <button className={'workspace-tab ' + (tab === 'projects' ? 'active' : '')} role="tab" aria-selected={tab === 'projects'} onClick={() => setTab('projects')}>我的项目 <span>{agents.length}</span></button>
      <button className={'workspace-tab ' + (tab === 'runs' ? 'active' : '')} role="tab" aria-selected={tab === 'runs'} onClick={() => setTab('runs')}>运行记录</button>
      <button className={'workspace-tab ' + (tab === 'settings' ? 'active' : '')} role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>接入配置</button>
    </div>
    {tab === 'templates' && <TemplateGrid onCreateFromTemplate={onCreateFromTemplate} />}
    {tab === 'projects' && <section className="project-panel"><div className="section-heading"><div><h2>我的项目</h2><p>仅显示当前用户拥有的 Agent</p></div><button className="text-button" disabled={!capabilities.agentLifecycle} onClick={onCreate}><Plus />创建 Agent</button></div><div className="agent-list">{agents.map((item) => <AgentRow key={item.id} agent={item} selected={item.id === selectedId} favorite={favorites.some((favorite) => favorite.targetType === 'agent' && favorite.targetId === item.id)} onSelect={() => onSelect(item.id)} onChat={() => onChat(item)} onToggleFavorite={() => onToggleFavorite(item)} />)}{agents.length === 0 && <Empty onCreate={onCreate} />}</div></section>}
    {tab === 'runs' && <PlaceholderPanel title="运行记录" description="查看当前用户 Agent 的运行状态与执行记录。" icon={<Activity />} onNavigate={() => setTab('projects')} action="查看我的项目" />}
    {tab === 'settings' && <PlaceholderPanel title="接入配置" description="管理当前用户 Agent 的访问方式与客户端接入参数。" icon={<Settings2 />} onNavigate={() => setTab('projects')} action="查看我的项目" />}
  </div>;
}
function AgentCard({ agent, onChat }: { agent: BackendAgent; onChat: (agent: BackendAgent) => void }) { const capabilities = useContext(CapabilitiesContext); const state = capabilities.agentExecution ? (statusCopy[agent.status as keyof typeof statusCopy] ?? statusCopy.provisioning) : { label: '历史记录', tone: 'pending' }; return <article className="agent-card"><div className="agent-card-top"><span className="agent-avatar"><Bot /></span><span className={'status-pill ' + state.tone}>{state.tone === 'ready' ? <CheckCircle2 /> : <Clock3 />}{state.label}</span></div><h3>{agent.name}</h3><p className="agent-id">{agent.id}</p><dl><div><dt>运行地址</dt><dd>{agent.host || 'agent-' + agent.id + '.localhost'}</dd></div><div><dt>Runtime</dt><dd>{engineLabel(agent)}</dd></div></dl>{!capabilities.agentExecution ? <span className="row-action muted">未开放执行</span> : agent.status === 'ready' ? <button className="button primary full" onClick={() => onChat(agent)}><MessageSquare />开始对话</button> : <div className="agent-pending"><LoaderCircle className="spin" />Worker 正在准备 Agent</div>}</article>; }
function AgentRow({ agent, selected, favorite, onSelect, onChat, onToggleFavorite }: { agent: BackendAgent; selected: boolean; favorite: boolean; onSelect: () => void; onChat: () => void; onToggleFavorite: () => void }) { const capabilities = useContext(CapabilitiesContext); const state = capabilities.agentExecution ? (statusCopy[agent.status as keyof typeof statusCopy] ?? statusCopy.provisioning) : { label: '历史记录', tone: 'pending' }; return <button className={'agent-row ' + (selected ? 'selected' : '')} onClick={onSelect}><span className="agent-avatar small"><Bot /></span><span className="agent-row-main"><strong>{agent.name}</strong><small>{agent.id}</small></span><span className={'status-pill ' + state.tone}>{state.tone === 'ready' ? <CheckCircle2 /> : <Clock3 />}{state.label}</span><span className="agent-row-host">{agent.host || 'agent-' + agent.id + '.localhost'}</span><span className={'agent-star' + (favorite ? ' on' : '')} role="button" tabIndex={0} title={favorite ? '取消收藏' : '收藏'} aria-label={favorite ? '取消收藏' : '收藏'} onClick={(event) => { event.stopPropagation(); onToggleFavorite(); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); onToggleFavorite(); } }}><Star /></span>{!capabilities.agentExecution ? <span className="row-action muted">未开放执行</span> : agent.status === 'ready' ? <span className="row-action" onClick={(event) => { event.stopPropagation(); onChat(); }}>对话 <Chevron /></span> : <span className="row-action muted">等待中</span>}</button>; }
function Chat({ agent, session, messages, text, sending, onText, onSubmit, onBack }: { agent: BackendAgent; session: Session; messages: ChatMessage[]; text: string; sending: boolean; onText: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onBack: () => void }) { const capabilities = useContext(CapabilitiesContext); return <div className="chat-page"><header className="chat-header"><button className="text-button" onClick={onBack}>返回 Agents</button><div className="chat-agent-title"><span className="agent-avatar small"><Bot /></span><div><h1>{agent.name}</h1><p><span className="connection-dot" />{session.title} · {engineLabel(agent)}</p></div></div><span className="status-pill ready"><CheckCircle2 />{capabilities.agentExecution ? '运行中' : '未开放执行'}</span></header><section className="chat-stream">{messages.map((item) => <article key={item.id} className={'chat-message ' + item.role}><span className="message-avatar">{item.role === 'user' ? '你' : item.role === 'assistant' ? <Bot /> : <Terminal />}</span><div><div className="message-meta"><strong>{item.role === 'user' ? '我' : item.role === 'assistant' ? agent.name : '系统'}</strong><time>{item.time}</time></div><p>{item.content}</p></div></article>)}</section><form className="chat-composer" onSubmit={onSubmit}><textarea value={text} onChange={(event) => onText(event.target.value)} placeholder="输入消息，开始与 Agent 对话..." rows={3} disabled={!capabilities.agentExecution || sending} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><button className="send-button" type="submit" title="发送消息" aria-label="发送消息" disabled={!capabilities.agentExecution || !text.trim() || sending}>{sending ? <LoaderCircle className="spin" /> : <Send />}</button></form></div>; }
function Metric({ icon: Icon, label, value, detail }: { icon: typeof Bot; label: string; value: string; detail: string }) { return <article className="metric-card"><span className="metric-icon"><Icon /></span><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>; }
function Empty({ onCreate }: { onCreate: () => void }) { const capabilities = useContext(CapabilitiesContext); return <div className="empty-state"><Bot /><h3>还没有 Agent</h3><p>{capabilities.agentLifecycle ? '创建你的第一个 Agent。' : 'Agent 服务暂未开放'}</p><button className="button primary" disabled={!capabilities.agentLifecycle} title={!capabilities.agentLifecycle ? capabilityNotice : undefined} onClick={onCreate}><Plus />创建 Agent</button></div>; }
function FavoritesPanel({ favorites, onOpen, onRemove, onGoCreateAgent, onGoLibrary }: { favorites: FavoriteItem[]; onOpen: (item: FavoriteItem) => void; onRemove: (item: FavoriteItem) => void; onGoCreateAgent: () => void; onGoLibrary: () => void }) { const capabilities = useContext(CapabilitiesContext); return <div className="page-stack"><section className="page-heading"><div><span className="eyebrow">快捷入口</span><h1>我的收藏</h1><p>收藏常用的 Agent 与客户端资源，随时从顶部回到业务现场。</p></div><div className="heading-actions"><button className="button secondary" onClick={onGoLibrary}><LibraryBig />浏览资源库</button><button className="button primary" disabled={!capabilities.agentLifecycle} title={!capabilities.agentLifecycle ? capabilityNotice : undefined} onClick={onGoCreateAgent}><Plus />创建 Agent</button></div></section>{favorites.length === 0 ? <section className="empty-state"><Star /><h3>还没有收藏</h3><p>把常用的 Agent 或客户端资源加入收藏后，会在这里统一展示。</p></section> : <div className="agent-list resource-list">{favorites.map((item) => { const isAgent = item.targetType === 'agent'; const ready = item.status === 'ready' || item.status === 'active'; const label = isAgent ? (!capabilities.agentExecution ? '历史记录' : item.status === 'ready' ? '运行中' : '待就绪') : item.status === 'active' ? '使用中' : '已收藏'; return <div key={item.id} className="resource-row"><span className={'resource-icon ' + (isAgent ? 'agent' : 'kb')}>{isAgent ? <Bot /> : <LibraryBig />}</span><span className="resource-main"><strong>{item.name || (isAgent ? item.targetId : '客户端资源')}</strong><small>{isAgent ? '智能体 Agent · ' + item.targetId : '资源库对象 · ' + item.targetId}</small></span><span className={'resource-kind ' + (isAgent ? 'agent' : 'kb')}>{isAgent ? 'Agent' : '资源'}</span><span className={'status-pill ' + (ready ? 'ready' : 'pending')}>{ready ? <CheckCircle2 /> : <Clock3 />}{label}</span><span className="resource-actions"><button type="button" className="text-button" onClick={() => onOpen(item)}>打开 <Chevron /></button><button type="button" className="text-button danger" onClick={() => onRemove(item)}><Star />取消收藏</button></span></div>; })}</div>}</div>; }
function BillingPanel({ account, transactions, onTopUp }: { account: AccountInfo | null; transactions: BillingTransaction[]; onTopUp: (amountCents: number) => Promise<void> }) { const capabilities = useContext(CapabilitiesContext);
  const [amount, setAmount] = useState('100');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const yuan = (cents: number) => (cents / 100).toFixed(2);
  async function topUp() {
    const cents = Math.round(Number(amount) * 100); if (!capabilities.simulatedRecharge || !(cents > 0) || busy) return;
    setBusy(true); setMessage(null);
    try { await onTopUp(cents); setMessage('充值成功，余额与明细已更新。'); } catch (caught) { setMessage(caught instanceof Error ? caught.message : '充值失败，请稍后重试。'); } finally { setBusy(false); }
  }
  return <div className="page-stack"><section className="page-heading"><div><span className="eyebrow">平台服务</span><h1>费用中心</h1><p>{capabilities.simulatedRecharge ? '本地模拟账务' : '历史账户记录 · 充值暂未开放'}</p></div></section><section className="metric-grid"><Metric icon={Wallet} label="账户余额" value={'¥ ' + yuan(account?.balanceCents ?? 0)} detail={account ? '可用余额（元）' : '账户数据暂不可用'} />{capabilities.simulatedRecharge && <Metric icon={Zap} label="模拟对话单价" value="¥ 0.0001" detail="非真实账单" />}<Metric icon={Activity} label="累计流水" value={String(transactions.length)} detail="充值 + 消费记录" /></section><section className="panel-card"><div className="section-heading"><div><h2>账户充值</h2><span>{capabilities.simulatedRecharge ? '模拟充值，不涉及真实支付' : '暂未开放'}</span></div></div><div className="recharge-row">{['50', '100', '500'].map((value) => <button key={value} type="button" disabled={!capabilities.simulatedRecharge} className={'chip' + (amount === value ? ' active' : '')} onClick={() => { setAmount(value); setMessage(null); }}>¥{value}</button>)}<input className="recharge-input" disabled={!capabilities.simulatedRecharge} value={amount} inputMode="decimal" aria-label="充值金额（元）" onChange={(event) => { setAmount(event.target.value); setMessage(null); }} /><span className="recharge-unit">元</span><button type="button" className="button primary" disabled={!capabilities.simulatedRecharge || busy || !(Number(amount) > 0)} onClick={() => void topUp()}>{busy ? <LoaderCircle className="spin" /> : <Wallet />}{capabilities.simulatedRecharge ? '模拟充值' : '暂未开放'}</button></div>{message && <p className="inline-message">{message}</p>}</section><section className="panel-card"><div className="section-heading"><div><h2>收支明细</h2><span>最近的充值与消费记录</span></div></div>{transactions.length === 0 ? <div className="empty-state small"><Wallet /><h3>暂无交易记录</h3><p>暂无历史收支。</p></div> : <div className="tx-list">{transactions.map((item) => <div key={item.id} className="tx-row"><span className={'tx-icon ' + item.type}>{item.type === 'recharge' ? <Wallet /> : <Zap />}</span><span className="tx-main"><strong>{item.type === 'recharge' ? '账户充值' : item.description || 'Agent 对话消耗'}</strong><small>{item.id} · {formatTime(item.createdAt)}</small></span><span className={'tx-amount ' + item.type}>{item.type === 'recharge' ? '+' : '-'}¥{yuan(item.amountCents)}</span><span className="tx-after">余额 ¥{yuan(item.balanceAfterCents)}</span></div>)}</div>}</section></div>;
}
function FilingPanel({ filings, onCreate, onRefresh }: { filings: FilingRecord[]; onCreate: () => void; onRefresh: () => void }) {
  const meta = (status: FilingRecord['status']) => status === 'approved' ? { pill: 'ready', icon: <CheckCircle2 />, label: '已通过' } : status === 'rejected' ? { pill: 'rejected', icon: <CircleAlert />, label: '已驳回' } : { pill: 'pending', icon: <Clock3 />, label: '审核中' };
  return <div className="page-stack"><section className="page-heading"><div><span className="eyebrow">平台服务</span><h1>备案管理</h1><p>登记业务域名与主体信息，备案通过后用于平台侧 Agent 服务资质核验。</p></div><div className="heading-actions"><button className="button secondary" onClick={onRefresh}><RefreshCw />刷新</button><button className="button primary" onClick={onCreate}><Plus />提交备案</button></div></section>{filings.length === 0 ? <section className="empty-state"><ShieldCheck /><h3>还没有备案记录</h3><p>提交你的业务域名与主体信息，平台完成核验后将通过通知同步结果。</p><button className="button primary" onClick={onCreate}><Plus />提交备案</button></section> : <div className="agent-list resource-list">{filings.map((item) => { const state = meta(item.status); return <div key={item.id} className="resource-row"><span className="resource-icon kb"><ShieldCheck /></span><span className="resource-main"><strong>{item.domain}</strong><small>{item.subjectName} · {item.subjectType === 'enterprise' ? '企业主体' : '个人主体'} · {item.id}</small></span><span className="resource-kind kb">网站备案</span><span className={'status-pill ' + state.pill}>{state.icon}{state.label}</span><span className="resource-actions"><span className="filing-time">提交于 {formatTime(item.createdAt)}</span>{item.icpNumber ? <span className="filing-icp">备案号 {item.icpNumber}</span> : null}</span></div>; })}</div>}</div>;
}
function SettingsModal({ displayName, onSubmit, onClose }: { displayName: string | null; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(displayName ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setMessage(null);
    try { await onSubmit(name); } catch (caught) { setMessage(caught instanceof Error ? caught.message : '保存设置失败'); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true"><header><div><span className="modal-icon"><Settings /></span><div><h2>个人设置</h2><p>管理显示昵称等偏好信息</p></div></div><button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X /></button></header><form onSubmit={submit}><label>显示昵称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="展示在控制台顶部用户区" /></label><p className="form-hint">昵称仅用于当前账户展示，留空时显示登录邮箱。</p>{message && <p className="form-error">{message}</p>}<footer><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" /> : null}保存设置</button></footer></form></section></div>;
}
function FilingModal({ onSubmit, onClose }: { onSubmit: (input: { domain: string; subjectName: string; subjectType: 'enterprise' | 'individual'; icpNumber?: string }) => Promise<void>; onClose: () => void }) {
  const [domain, setDomain] = useState('');
  const [subjectName, setSubjectName] = useState('');
  const [subjectType, setSubjectType] = useState<'enterprise' | 'individual'>('enterprise');
  const [icpNumber, setIcpNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const host = domain.trim(); const subject = subjectName.trim(); if (!host || !subject || busy) return;
    setBusy(true); setMessage(null);
    try { await onSubmit({ domain: host, subjectName: subject, subjectType, icpNumber: icpNumber.trim() || undefined }); } catch (caught) { setMessage(caught instanceof Error ? caught.message : '提交备案失败'); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true"><header><div><span className="modal-icon"><ShieldCheck /></span><div><h2>提交备案</h2><p>登记域名与主体信息，平台核验后同步通知结果</p></div></div><button className="icon-button" title="关闭" aria-label="关闭" onClick={onClose}><X /></button></header><form onSubmit={submit}><label>备案域名<input autoFocus value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="例如：example.com（不含协议头）" /></label><label>主体名称<input value={subjectName} onChange={(event) => setSubjectName(event.target.value)} placeholder="企业全称或个人姓名" /></label><label>主体类型<select value={subjectType} onChange={(event) => setSubjectType(event.target.value as 'enterprise' | 'individual')}><option value="enterprise">企业主体</option><option value="individual">个人主体</option></select></label><label>ICP 备案号<input value={icpNumber} onChange={(event) => setIcpNumber(event.target.value)} placeholder="已取得的 ICP 备案号（可选）" /></label><p className="form-hint">提交后进入审核中状态，域名需为可解析的合法格式。</p>{message && <p className="form-error">{message}</p>}<footer><button type="button" className="button secondary" onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={!domain.trim() || !subjectName.trim() || busy}>{busy ? <LoaderCircle className="spin" /> : <Plus />}提交备案</button></footer></form></section></div>;
}
function Chevron() { return <span aria-hidden="true">›</span>; }
