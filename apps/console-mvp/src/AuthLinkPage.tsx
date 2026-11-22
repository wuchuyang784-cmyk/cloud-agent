import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { AuthPage } from './AuthPage';
import { confirmEmailVerification, confirmPasswordReset, type ApiError } from './api';

const INVALID_LINK = '链接无效或已过期。请申请新的邮件链接。';

export function AuthLinkPage({ kind, initialToken, onSignIn }: {
  kind: 'verify' | 'reset';
  initialToken: string | null;
  onSignIn: (notice?: string) => void;
}) {
  const [token, setToken] = useState(initialToken);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialToken ? '' : INVALID_LINK);
  const isReset = kind === 'reset';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || busy) return;
    if (isReset && (password.length < 12 || password.length > 128)) {
      setError('新密码需要 12 至 128 位字符。');
      return;
    }
    if (isReset && password !== confirmation) {
      setError('两次输入的密码需一致。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (isReset) await confirmPasswordReset(token, password);
      else await confirmEmailVerification(token);
      setToken(null);
      setPassword('');
      setConfirmation('');
      onSignIn(isReset ? '密码已重置，请使用新密码登录。' : '邮箱验证成功，请登录。');
    } catch (caught) {
      if ((caught as ApiError)?.code === 'invalid_or_expired_link') {
        setToken(null);
        setPassword('');
        setConfirmation('');
        setError(INVALID_LINK);
      } else {
        setError('暂时无法处理请求，请稍后重试。');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPage title={isReset ? '重置密码' : '验证邮箱'} description={token ? (isReset ? '输入并确认新密码。' : '确认后验证收到此链接的邮箱。') : undefined}>
      <form onSubmit={submit} noValidate>
        {token && isReset && <>
          <label className="auth-field">
            <span>新密码</span>
            <input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} />
          </label>
          <label className="auth-field">
            <span>确认新密码</span>
            <input type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
          </label>
        </>}
        {error && <p className="auth-error" role="alert"><CircleAlert />{error}</p>}
        {token && <button type="submit" className="button primary auth-submit" disabled={busy}>
          {busy && <LoaderCircle className="spin" />}
          {isReset ? '保存新密码' : '确认验证邮箱'}
        </button>}
      </form>
      <button type="button" className="button secondary auth-secondary" disabled={busy} onClick={() => onSignIn()}>返回登录</button>
    </AuthPage>
  );
}
