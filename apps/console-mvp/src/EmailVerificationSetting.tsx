import { useState } from 'react';
import { requestEmailVerification, type ApiError } from './api';

export function EmailVerificationSetting({ userId, verified, canRequest }: { userId: string; verified: boolean; canRequest: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'accepted' | 'failed' | 'account_changed' | null>(null);

  async function request() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      await requestEmailVerification(userId);
      setResult('accepted');
    } catch (caught) {
      setResult((caught as ApiError)?.code === 'account_changed' ? 'account_changed' : 'failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-email-verification">
      <p className="form-hint">{verified ? '邮箱已验证' : '邮箱未验证'}</p>
      {!verified && canRequest && <>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void request()}>申请验证邮件</button>
        {result === 'accepted' && <p className="form-hint" role="status">如果该邮箱可以验证，请查收验证邮件。</p>}
        {result === 'failed' && <p className="form-error" role="alert">暂时无法处理请求，请稍后重试。</p>}
        {result === 'account_changed' && <p className="form-error" role="alert">登录账号已切换，请刷新页面后再申请。</p>}
      </>}
    </div>
  );
}
