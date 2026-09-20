import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck, X } from 'lucide-react';
import { AdminSession } from './session';
import type { AccountState, Governance } from './session';

export const accountLabels: Record<string, string> = { active: '正常', suspended: '服务暂停', banned: '已封禁' };
export function GovernanceDialog({ model, value, canGovern }: { model: AdminSession; value: Governance; canGovern: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<AccountState['status']>('suspended');
  const [reason, setReason] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const locked = value.busy || Boolean(value.retry);
  return <dialog ref={dialog} className="governance-dialog" onCancel={e => { e.preventDefault(); model.closeGovernance(); }} aria-labelledby="governance-heading">
    <header><h2 id="governance-heading"><ShieldCheck size={20} />账号治理</h2><button className="icon-button" title="关闭" aria-label="关闭账号治理" onClick={model.closeGovernance}><X size={18} /></button></header>
    <div className="governance-identity"><strong>{value.target.email || value.target.displayName || value.target.id}</strong><code>{value.target.id}</code></div>
    <div className="governance-current"><span>当前状态：<strong>{value.account ? accountLabels[value.account.status] : '待确认'}</strong></span>
      <button className="icon-button" title="刷新账号状态" aria-label="刷新账号状态" disabled={value.busy} onClick={() => void model.openGovernance(value.target)}><RefreshCw size={16} /></button></div>
    {value.error && <p className="error" role="alert">{value.error}</p>}{value.success && <p className="governance-success" role="status">{value.success}</p>}
    {canGovern && <form onSubmit={e => { e.preventDefault(); void model.govern(status, reason); }}>
      <label>账号操作<select aria-label="账号操作" disabled={locked || !value.account} value={value.retry?.status ?? status} onChange={e => setStatus(e.target.value as AccountState['status'])}>
        <option value="suspended">暂停服务</option><option value="banned">封禁账号</option><option value="active">解除限制</option></select></label>
      <p className="governance-impact">{(value.retry?.status ?? status) === 'banned' ? '禁止登录，撤销全部现有会话。历史数据保留。' : (value.retry?.status ?? status) === 'suspended' ? '保留登录和本人历史查询，禁止业务写入及管理端访问。' : '恢复账号权限。旧会话不恢复，Agent 不会自动启动。'}</p>
      <label>操作原因<textarea aria-label="操作原因" minLength={2} maxLength={500} required rows={3} disabled={locked || !value.account} value={value.retry?.reason ?? reason} onChange={e => setReason(e.target.value)} /></label>
      <button type="submit" className="primary" disabled={value.busy || !value.account || (!value.retry && (reason.trim().length < 2 || status === value.account.status))}>{value.busy ? '处理中' : value.retry ? '重试原请求' : '确认操作'}</button>
    </form>}
    <section className="governance-history"><h3>治理记录</h3>{value.busy && <p role="status">正在读取或提交</p>}
      {!value.busy && value.items.length === 0 && <p className="subtext">暂无治理记录</p>}
      <ol>{value.items.map(item => <li key={item.id}><div><strong>{accountLabels[item.previousStatus]} → {accountLabels[item.status]}</strong><time>{new Date(item.occurredAt).toLocaleString('zh-CN', { hour12: false })}</time></div><p>{item.reason}</p><code>操作人：{item.actorUserId}</code></li>)}</ol>
      {value.nextCursor && <button disabled={value.busy} onClick={() => void model.openGovernance(value.target, value.nextCursor!)}>更早记录</button>}
    </section>
  </dialog>;
}
