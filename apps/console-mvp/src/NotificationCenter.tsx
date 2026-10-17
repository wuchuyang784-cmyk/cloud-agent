import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Bell, CheckCheck, ChevronLeft, ChevronRight, Megaphone, RefreshCw, X } from 'lucide-react';
import type { NotificationItem, NotificationSnapshot } from './notification-state';
import { NotificationSession } from './notification-state';
import './notifications.css';

const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '长期有效';
const locked = (value: NotificationSnapshot) => value.busy || Boolean(value.pending);
function Feedback({ model, value }: { model: NotificationSession; value: NotificationSnapshot }) {
  return <>
    {!value.canWrite && value.identityKey && <p className="nc-help" role="status">账号服务已暂停，公告和通知可查看，暂不能标记已读。</p>}
    {value.error && <div className="nc-feedback" role="alert"><p>{value.error}</p>{value.pending
      ? <button type="button" className="text-button" disabled={value.busy} onClick={() => void model.retry()}>重试原已读请求</button>
      : <button type="button" className="text-button" disabled={value.refreshing} onClick={() => void model.refresh()}>重试通知读取</button>}</div>}
    {value.success && <p className="nc-success" role="status">{value.success}</p>}
  </>;
}
function NotificationRows({ items, model, onOpen }: { items: NotificationItem[]; model: NotificationSession; onOpen?: () => void }) {
  return <div className="nc-list">{items.map(item => <button key={item.id} type="button" aria-label={'查看通知 ' + item.title}
    disabled={locked(model.getSnapshot())} className={'notice-item nc-row' + (item.isRead ? ' read' : '')}
    onClick={() => { onOpen?.(); void model.open(item); }}>
    <span className="notice-icon">{item.source === 'announcement' ? <Megaphone /> : <Bell />}</span>
    <span className="notice-main"><span className="nc-row-tags"><span>{item.source === 'announcement' ? '平台公告' : '个人通知'}</span>
      {item.pinned && <span>置顶</span>}{item.severity === 'important' && <span className="nc-important">重要</span>}{item.status === 'expired' && <span>已结束</span>}
      <span>{item.isRead ? '已读' : item.status === 'expired' ? '不计未读' : '未读'}</span></span>
      <strong>{item.title}</strong><p>{item.body}</p><small>{date(item.createdAt)} · 北京时间</small></span>
    {!item.isRead && item.status !== 'expired' && <i aria-hidden="true" />}
  </button>)}</div>;
}
export function NotificationBell({ model, open, onToggle }: { model: NotificationSession; open: boolean; onToggle: () => void }) {
  const value = useSyncExternalStore(model.subscribe, model.getSnapshot), unread = value.unreadCount;
  return <button className={'icon-button' + (open ? ' active' : '')} title={unread === null ? '通知：未读数未知' : '通知'}
    aria-label="通知" aria-expanded={open} aria-controls={open ? 'recent-notifications' : undefined} onClick={onToggle}>
    <Bell />{unread === null ? <span className="bell-badge nc-unknown" aria-label="未读数未知">?</span>
      : unread > 0 ? <span className="bell-badge" aria-label={'未读 ' + unread + ' 条'}>{unread > 99 ? '99+' : unread}</span> : null}
  </button>;
}
export function NotificationPopover({ model, onClose, onAll }: { model: NotificationSession; onClose: () => void; onAll: () => void }) {
  const value = useSyncExternalStore(model.subscribe, model.getSnapshot);
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [onClose]);
  return <><div className="pop-layer" onClick={onClose} /><section className="notice-pop nc-pop" id="recent-notifications" aria-label="最近通知">
    <header className="notice-pop-head"><strong>通知中心</strong><button className="text-button" disabled={!value.canWrite || locked(value) || !value.unreadCount} onClick={() => void model.markAll()}>全部已读</button>
      <button className="icon-button" aria-label="关闭通知列表" onClick={onClose}><X /></button></header>
    <div className="notice-pop-list"><Feedback model={model} value={value} />
      {value.phase === 'loading' && <p className="nc-help" role="status">正在读取通知…</p>}
      {value.phase === 'ready' && !value.items.length && <p className="nc-help">暂无通知</p>}
      <NotificationRows items={value.items.slice(0, 12)} model={model} onOpen={onClose} /></div>
    <footer className="nc-pop-footer"><span>{value.unreadCount === null ? '未读数未知' : '未读 ' + value.unreadCount + ' 条'}</span><button className="text-button" onClick={onAll}>查看全部</button></footer>
  </section></>;
}
export function NotificationCenter({ model }: { model: NotificationSession }) {
  const value = useSyncExternalStore(model.subscribe, model.getSnapshot);
  return <section className="page-stack nc-center" aria-label="通知中心">
    <header className="page-heading"><div><span className="eyebrow">个人消息</span><h1>通知中心</h1><p>平台公告与本人的系统通知；未读数以服务端为准。</p></div>
      <div className="heading-actions"><button className="button secondary" disabled={value.refreshing || locked(value)} onClick={() => void model.refresh()}><RefreshCw />刷新通知</button>
        <button className="button primary" disabled={!value.canWrite || locked(value) || !value.unreadCount} onClick={() => void model.markAll()}><CheckCheck />全部已读</button></div></header>
    <p className="nc-help">全部已读针对本次操作时可见的全部通知，不受筛选或分页限制；之后发布的新公告仍保持未读。所有时间为 Asia/Shanghai。</p>
    <div className="nc-toolbar"><label>通知来源<select aria-label="通知来源" disabled={locked(value)} value={value.query.source} onChange={event => void model.filter({ source: event.target.value as 'all' | 'notification' | 'announcement' })}>
      <option value="all">全部来源</option><option value="announcement">平台公告</option><option value="notification">个人通知</option></select></label>
      <label>阅读状态<select aria-label="阅读状态" disabled={locked(value)} value={value.query.read} onChange={event => void model.filter({ read: event.target.value as 'all' | 'unread' | 'read' })}>
        <option value="all">全部状态</option><option value="unread">未读</option><option value="read">已读</option></select></label>
      <label className="nc-history"><input type="checkbox" disabled={locked(value)} checked={value.query.history} onChange={event => void model.filter({ history: event.target.checked })} />查看已结束公告</label>
      <span className="nc-count" aria-live="polite">{value.unreadCount === null ? '未读数未知' : '全局未读 ' + value.unreadCount + ' 条'}</span></div>
    <Feedback model={model} value={value} />
    <section className="nc-card" aria-label="通知列表" aria-busy={value.refreshing}>
      {value.phase === 'loading' && <p className="nc-help" role="status">正在读取通知…</p>}
      {value.phase === 'ready' && !value.items.length && <p className="nc-help">暂无符合条件的通知</p>}
      <NotificationRows items={value.items} model={model} /></section>
    <footer className="nc-pagination"><span>{value.updatedAt ? '上次更新 ' + date(new Date(value.updatedAt).toISOString()) : '尚未完成更新'}</span><div>
      <label>每页 <select aria-label="通知每页条数" disabled={value.refreshing || locked(value)} value={value.query.limit} onChange={event => void model.filter({ limit: Number(event.target.value) })}>{[25, 50, 100].map(n => <option key={n}>{n}</option>)}</select></label>
      <button className="icon-button" aria-label="通知上一页" disabled={value.refreshing || locked(value) || !value.history.length} onClick={() => void model.back()}><ChevronLeft /></button><span>{value.history.length + 1}</span>
      <button className="icon-button" aria-label="通知下一页" disabled={value.refreshing || locked(value) || !value.nextCursor} onClick={() => void model.next()}><ChevronRight /></button></div></footer>
  </section>;
}
function DetailDialog({ model, value }: { model: NotificationSession; value: NotificationSnapshot }) {
  const ref = useRef<HTMLDialogElement>(null), item = value.detail.item;
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  const close = () => { if (!value.busy) model.closeDetail(); };
  return <dialog ref={ref} className="nc-dialog" aria-labelledby="notification-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2 id="notification-title">{item?.source === 'announcement' ? '公告详情' : '通知详情'}</h2><button className="icon-button" aria-label="关闭通知详情" disabled={value.busy} onClick={close}><X /></button></header>
    {value.detail.phase === 'loading' && <p role="status">正在读取完整内容…</p>}
    {value.detail.error && <p className="nc-feedback" role="alert">{value.detail.error}</p>}
    <Feedback model={model} value={value} />
    {item && <article><div className="nc-row-tags"><span>{item.source === 'announcement' ? '平台公告' : '个人通知'}</span>{item.severity === 'important' && <span className="nc-important">重要</span>}{item.pinned && <span>置顶</span>}<span>{item.status === 'expired' ? '已结束，不计未读' : item.isRead ? '已读' : '未读'}</span></div>
      <h3>{item.title}</h3><p className="nc-detail-body">{item.body}</p><dl><div><dt>{item.source === 'announcement' ? '发布时间' : '通知时间'}</dt><dd>{date(item.createdAt)}</dd></div>
        {item.source === 'announcement' && <div><dt>有效截止</dt><dd>{date(item.expiresAt)}</dd></div>}</dl><p className="nc-help">时间：Asia/Shanghai（北京时间）。</p></article>}
  </dialog>;
}
export function NotificationDetail({ model }: { model: NotificationSession }) {
  const value = useSyncExternalStore(model.subscribe, model.getSnapshot);
  return value.detail.phase === 'idle' ? value.pending && <aside className="nc-recovery" aria-label="通知操作恢复"><Feedback model={model} value={value} /></aside>
    : <DetailDialog model={model} value={value} />;
}
