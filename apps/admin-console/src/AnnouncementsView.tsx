import { useState, useSyncExternalStore } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Megaphone, Plus, RefreshCw, Search } from 'lucide-react';
import { AnnouncementEditor } from './AnnouncementEditor';
import { AnnouncementSession, announcementDate, announcementLabels, announcementStateLabel } from './announcements';
import './announcements.css';

export function AnnouncementsView({ model }: { model: AnnouncementSession }) {
  const value = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [search, setSearch] = useState(value.query.q);
  const loading = value.phase === 'loading' || value.phase === 'idle';
  return <section aria-label="公告管理">
    <p className="announcement-help">管理全平台公告与发布审计。定时计划由独立发布器执行；保存草稿或设置定时不等于发布，实际生效请核对状态与审计。</p>
    <form className="toolbar" onSubmit={e => { e.preventDefault(); void model.filter({ q: search.trim() }); }}>
      <div className="search-field"><Search size={17} /><input aria-label="搜索公告标题" placeholder="搜索公告标题" maxLength={200} value={search} onChange={e => setSearch(e.target.value)} /><button className="icon-button" type="submit" aria-label="搜索公告"><ArrowRight size={16} /></button></div>
      <select aria-label="公告状态筛选" value={value.query.status} onChange={e => void model.filter({ status: e.target.value })}><option value="">全部公告状态</option>{Object.entries(announcementLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select>
      <div className="toolbar-end"><button className="icon-button" type="button" aria-label="刷新公告列表" title="刷新公告列表" disabled={loading} onClick={() => void model.load()}><RefreshCw size={17} /></button>
        {value.canManage && <button className="primary" type="button" disabled={value.busy || Boolean(value.pending)} onClick={() => model.newDraft()}><Plus size={16} />新建公告</button>}</div>
    </form>
    {value.phase !== 'error' && value.error && !value.selected && !value.draft && !value.detailLoading && <p className="error announcement-feedback" role="alert">{value.error}</p>}
    {value.phase === 'error' ? <div className="announcement-list-error" role="alert"><p>{value.error}</p><button onClick={() => void model.load()}>重试读取公告</button></div>
      : <><div className="table-scroll"><table className="announcement-table"><thead><tr><th>公告</th><th>状态 / 级别</th><th>计划 / 实际发布时间</th><th>有效期</th><th>最近操作人</th><th>操作</th></tr></thead>
        <tbody>{!loading && value.items.map(item => <tr key={item.id}><td><strong>{item.title}</strong><code className="subtext">v{item.version} · {item.id}</code>{item.pinned && <span className="badge">置顶</span>}</td><td><span className={'badge ' + (item.status === 'published' ? 'positive' : '')}>{announcementStateLabel(item)}</span><span className="subtext">{item.severity === 'important' ? '重要' : '普通'}</span></td>
          <td className="date"><span>计划：{announcementDate(item.scheduledAt)}</span><span className="subtext">实际：{announcementDate(item.publishedAt)}</span></td><td className="date">{item.status === 'draft' && item.expiryDays === 30 ? '发布后 30 天' : item.expiresAt ? announcementDate(item.expiresAt) : '长期有效'}</td><td><code>{item.updatedBy ?? item.createdBy ?? '—'}</code><span className="subtext">{announcementDate(item.updatedAt)}</span></td><td><button className="row-action" aria-label={'查看公告 ' + item.title} onClick={() => void model.open(item.id)}>查看 / 审计</button></td></tr>)}
          {(loading || !value.items.length) && <tr><td colSpan={6}><div className="empty" role="status"><Megaphone size={28} /><span>{loading ? '正在读取公告' : '暂无符合条件的公告'}</span></div></td></tr>}</tbody></table></div>
        <footer className="pagination"><span>本页 {value.items.length} 条</span><div><label>每页 <select aria-label="公告每页条数" value={value.query.limit} disabled={loading} onChange={e => void model.filter({ limit: Number(e.target.value) })}>{[25, 50, 100].map(n => <option key={n}>{n}</option>)}</select> 条</label>
          <button className="icon-button" aria-label="公告上一页" disabled={loading || !value.history.length} onClick={() => void model.back()}><ChevronLeft size={18} /></button><span>{value.history.length + 1}</span><button className="icon-button" aria-label="公告下一页" disabled={loading || !value.nextCursor} onClick={() => void model.next()}><ChevronRight size={18} /></button></div></footer></>}
    {(value.draft || value.selected || value.detailLoading) && <AnnouncementEditor key={value.selected?.id ?? 'new'} model={model} value={value} />}
  </section>;
}
