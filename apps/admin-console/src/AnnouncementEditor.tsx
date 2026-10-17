import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, Eye, Megaphone, Save, X } from 'lucide-react';
import { AnnouncementSession, announcementDate, announcementStateLabel, draftError } from './announcements';
import type { AnnouncementSnapshot } from './announcements';

const auditLabels: Record<string, string> = { created: '创建草稿', draft_updated: '编辑草稿', schedule_set: '设置定时', schedule_cancelled: '取消定时', published: '发布公告', withdrawn: '撤回公告', expired: '公告过期', publish_blocked: '发布阻塞' };

export function AnnouncementEditor({ model, value }: { model: AnnouncementSession; value: AnnouncementSnapshot }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState(false);
  const [reason, setReason] = useState('');
  const [scheduledLocal, setScheduledLocal] = useState('');
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  const item = value.selected, draft = value.draft, locked = value.busy || Boolean(value.pending) || value.needsReload;
  const close = () => {
    if (value.busy || value.pending) return;
    if (value.dirty && !window.confirm('草稿尚未保存，关闭将丢弃本地编辑，是否继续？')) return;
    model.close(); void model.load();
  };
  const validation = draft ? draftError(draft) : '';
  const title = draft?.title || item?.title || '新建公告';
  const body = draft?.body ?? item?.body ?? '';
  return <dialog ref={ref} className="announcement-dialog" aria-labelledby="announcement-heading" onCancel={e => { e.preventDefault(); close(); }}>
    <header className="announcement-dialog-heading"><h2 id="announcement-heading"><Megaphone size={20} />{item ? '公告详情' : '新建公告'}</h2>
      <button className="icon-button" aria-label="关闭公告" title="关闭公告" disabled={value.busy || Boolean(value.pending)} onClick={close}><X size={18} /></button></header>
    {value.detailLoading ? <p role="status">正在读取公告详情…</p> : <>
      <div className="announcement-meta"><span className={'badge ' + (item?.status === 'published' ? 'positive' : '')}>{item ? announcementStateLabel(item) : '未保存草稿'}</span>
        {item && <><span>版本 {item.version}</span><code>{item.id}</code></>}
        {value.dirty && <span>有未保存修改</span>}</div>
      <p className="announcement-help">全部时间为 Asia/Shanghai（北京时间）。已发布正文不可直接改写，纠错请撤回后复制新稿。</p>
      {value.error && <p className="error announcement-feedback" role="alert">{value.error}</p>}
      {value.success && <p className="governance-success" role="status">{value.success}</p>}
      {value.pending && <div className="announcement-feedback"><p>结果尚未确认，编辑已锁定；请重试原请求以避免重复提交。</p><button disabled={value.busy} onClick={() => void model.retry()}>重试原请求</button></div>}
      {value.needsReload && item && <button disabled={value.busy} onClick={() => void model.open(item.id)}>重新读取最新版本（放弃本地编辑）</button>}
      <div className="announcement-editor-tools">{draft && <button type="button" onClick={() => setPreview(!preview)}><Eye size={16} />{preview ? '返回编辑' : '预览公告'}</button>}
        {item && value.canManage && <button disabled={locked || value.dirty} onClick={() => { setPreview(false); model.newDraft(item); }}><Copy size={16} />复制为新草稿</button>}</div>
      {draft && !preview ? <form className="announcement-form" onSubmit={e => { e.preventDefault(); void model.save(); }}>
        <label>公告标题<input aria-label="公告标题" required maxLength={240} value={draft.title} disabled={locked} onChange={e => model.updateDraft({ title: e.target.value })} /><span className="subtext">{[...draft.title].length}/120 字符</span></label>
        <label>公告正文<textarea aria-label="公告正文" required maxLength={40000} rows={9} value={draft.body} disabled={locked} onChange={e => model.updateDraft({ body: e.target.value })} /><span className="subtext">{[...draft.body].length}/20000 字符，纯文本，不解析 HTML。</span></label>
        <div className="announcement-form-grid"><label>公告级别<select aria-label="公告级别" value={draft.severity} disabled={locked} onChange={e => model.updateDraft({ severity: e.target.value as 'normal' | 'important' })}><option value="normal">普通</option><option value="important">重要</option></select></label>
          <label>有效期<select aria-label="公告有效期" value={draft.expiryMode} disabled={locked} onChange={e => model.updateDraft({ expiryMode: e.target.value as 'default' | 'forever' | 'at' })}><option value="default">发布后 30 天</option><option value="forever">长期有效</option><option value="at">指定截止时间</option></select></label></div>
        {draft.expiryMode === 'at' && <label>有效截止时间（北京时间）<input aria-label="有效截止时间" type="datetime-local" step="0.001" required value={draft.expiresLocal} disabled={locked} onChange={e => model.updateDraft({ expiresLocal: e.target.value })} /></label>}
        <label className="announcement-checkbox"><input type="checkbox" checked={draft.pinned} disabled={locked} onChange={e => model.updateDraft({ pinned: e.target.checked })} />置顶公告</label>
        <p className="announcement-help" aria-live="polite">{validation || '保存草稿不会发布，保存后可预览并确认立即或定时发布。'}</p>
        <button type="submit" className="primary" disabled={locked || Boolean(validation) || !value.dirty}><Save size={16} />{value.busy ? '保存中' : '保存草稿'}</button>
      </form> : <article className="announcement-preview" aria-label="公告预览"><div><span className="badge">{(draft?.severity ?? item?.severity) === 'important' ? '重要公告' : '平台公告'}</span>{(draft?.pinned ?? item?.pinned) && <span className="badge">置顶</span>}</div><h3>{title}</h3><p>{body}</p></article>}
      {item && <dl className="announcement-times"><div><dt>实际发布时间</dt><dd>{announcementDate(item.publishedAt)}</dd></div><div><dt>计划发布时间</dt><dd>{announcementDate(item.scheduledAt)}</dd></div><div><dt>有效截止时间</dt><dd>{item.expiryDays === 30 && item.status === 'draft' ? '发布后 30 天' : item.expiresAt ? announcementDate(item.expiresAt) : '长期有效'}</dd></div></dl>}
      {item?.status === 'scheduled' && <div className="announcement-help" role="status">{item.publishBlocked
        ? '定时责任人的治理状态或平台权限已变更，旧计划已阻塞；解除限制不会自动恢复。请取消定时，再由有效管理员重新确认。'
        : '定时计划尚未发布。由独立发布器按数据库时间处理；若超过计划时间仍待发布，请刷新并检查发布器监控。'}
        {item.lastPublishError === 'publisher_item_failed' && <p>最近一次处理失败，系统将退避重试；未确认发布成功。</p>}
        {item.nextPublishAttemptAt && <p>下次尝试：{announcementDate(item.nextPublishAttemptAt)}</p>}</div>}
      {item?.withdrawalReason && <p>撤回原因：{item.withdrawalReason}</p>}
      {value.canManage && item && !value.confirmation && <div className="announcement-actions">
        {item.status === 'draft' && <button className="primary" disabled={locked || value.dirty} onClick={() => model.confirm('publish')}><Megaphone size={16} />立即发布</button>}
        {item.status === 'draft' && <button disabled={locked || value.dirty} onClick={() => model.confirm('schedule')}>定时发布</button>}
        {item.status === 'scheduled' && <button disabled={locked} onClick={() => model.confirm('cancel-schedule')}>取消定时</button>}
        {item.status === 'published' && <button disabled={locked} onClick={() => model.confirm('withdraw')}>撤回公告</button>}
      </div>}
      {value.confirmation && <section className="announcement-confirm" aria-label={value.confirmation === 'withdraw' ? '撤回确认' : value.confirmation === 'cancel-schedule' ? '取消定时确认' : '发布确认'}>
        <h3>{value.confirmation === 'publish' ? '确认立即发布' : value.confirmation === 'schedule' ? '确认定时发布' : value.confirmation === 'cancel-schedule' ? '确认取消定时' : '确认撤回公告'}</h3><strong>{title}</strong>
        <p>{value.confirmation === 'withdraw' ? '撤回后公告不再对业务端可见，历史和审计保留，不能抹除用户已经看过的内容。'
          : value.confirmation === 'cancel-schedule' ? '取消后退回草稿，原计划与阻塞不再执行；更改时间或责任人需要重新确认。若并发发布已生效，取消将被拒绝并要求重新读取。'
          : value.confirmation === 'schedule' ? '面向全部业务账户。保存的是定时计划，不等于已发布；实际生效时间以数据库与发布器审计为准。'
          : '发布后面向全部业务账户，在原通知中心显示；已发布正文不可直接修改。'}</p>
        {value.confirmation === 'schedule' && <label>计划发布时间（Asia/Shanghai，北京时间）<input aria-label="计划发布时间" type="datetime-local" step="1" required disabled={locked} value={scheduledLocal} onChange={e => setScheduledLocal(e.target.value)} /><span className="subtext">{scheduledLocal ? '北京时间：' + scheduledLocal.replace('T', ' ') : '请选择未来时间'}</span></label>}
        {value.confirmation === 'withdraw' && <label>撤回原因<textarea aria-label="撤回原因" required maxLength={1000} rows={3} disabled={value.busy} value={reason} onChange={e => setReason(e.target.value)} /></label>}
        <div className="announcement-actions"><button disabled={locked} onClick={model.cancelConfirmation}><ArrowLeft size={16} />返回</button><button className="primary" disabled={locked || (value.confirmation === 'schedule' && !scheduledLocal) || (value.confirmation === 'withdraw' && (!reason.trim() || [...reason].length > 500))} onClick={() => value.confirmation === 'schedule' ? void model.schedule(scheduledLocal) : void model.submit(reason)}><Check size={16} />{value.confirmation === 'publish' ? '确认发布' : value.confirmation === 'schedule' ? '确认定时' : value.confirmation === 'cancel-schedule' ? '确认取消定时' : '确认撤回'}</button></div>
      </section>}
      {item && <section className="announcement-audit"><h3>操作审计</h3>{value.audit.busy && <p role="status">正在读取记录…</p>}
        {value.audit.error && <p role="alert" className="error">{value.audit.error}<button disabled={value.audit.busy} onClick={() => void model.audit()}>重试读取记录</button></p>}
        {!value.audit.busy && !value.audit.error && !value.audit.items.length && <p className="subtext">暂无操作记录</p>}
        <ol>{value.audit.items.map(row => <li key={row.id}><div><strong>{auditLabels[row.action] ?? row.action}</strong><span>v{row.previousVersion} → v{row.version}</span><time dateTime={row.occurredAt}>{announcementDate(row.occurredAt)}</time></div>
          <code>{row.executorType === 'system' ? '系统发布器 · 原定时责任人：' : '操作人：'}{row.actorUserId ?? '系统'}</code>{row.executorType === 'system' && <p className="subtext">执行者：{row.executorId ?? '系统'} · 定时治理版本：{row.scheduleGovernanceVersion ?? '—'}</p>}{row.reason && <p>{row.reason}</p>}<details><summary>审计摘要</summary><code>内容 SHA-256：{row.contentHash}</code><p>字段：{row.changedFields.join('、') || '状态变更'}</p></details></li>)}</ol>
        {value.audit.nextCursor && <button disabled={value.audit.busy} onClick={() => void model.audit(value.audit.nextCursor!)}>加载更早记录</button>}
      </section>}
    </>}
  </dialog>;
}
