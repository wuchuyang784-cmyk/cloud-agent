import { ArrowRight, Building2, CircleAlert, LoaderCircle } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { loginAccount, registerAccount, requestPasswordReset, type ApiError, type EmailMode, type User } from './api';
import { AuthPage } from './AuthPage';

type Mode = 'sign-in' | 'sign-up' | 'forgot';

const VERIFICATION_REQUIRED = '邮箱尚未验证。请查收验证邮件，重新登录可再次申请，发送频率受限。';

// 服务端错误码到用户可读文案的映射（docs/30 §9 错误码表）。
const ERROR_COPY: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确，请重试。',
  USER_ALREADY_EXISTS: '该邮箱已注册，请直接登录。',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: '该邮箱已注册，请直接登录。',
  PASSWORD_TOO_SHORT: '密码至少需要 12 位字符。',
  PASSWORD_TOO_LONG: '密码不能超过 128 位字符。',
  TOO_MANY_REQUESTS: '操作过于频繁，请稍后再试。',
  too_many_requests: '操作过于频繁，请稍后再试。',
  identity_link_required: '此邮箱已有历史账号，请联系平台负责人核验并迁移，原数据不会自动合并。',
  invalid_credentials: '邮箱或密码不正确，请重试。',
  EMAIL_NOT_VERIFIED: VERIFICATION_REQUIRED,
  email_not_verified: VERIFICATION_REQUIRED,
  email_taken: '该邮箱已注册，请直接登录。',
  validation_error: '请检查填写内容是否符合要求。',
  unauthenticated: '登录状态已失效，请重新登录。',
  database_unavailable: '服务暂时不可用，请稍后再试。',
};

export function LoginPage({ emailMode, initialNotice, retryEmailConfig, onAuthenticated }: {
  emailMode: EmailMode | null;
  initialNotice?: string;
  retryEmailConfig?: () => void;
  onAuthenticated: (user: User) => void;
}) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(initialNotice ?? '');
  const isSignUp = mode === 'sign-up';
  const isForgot = mode === 'forgot';
  const canSignUp = emailMode === 'off' || emailMode === 'enforce';
  const emailEnabled = emailMode === 'transition' || emailMode === 'enforce';

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice('');
    if (next === 'forgot') setPassword('');
  }

  function describe(caught: unknown, fallback: string): string {
    const apiError = caught as ApiError;
    if (apiError?.code && ERROR_COPY[apiError.code]) return ERROR_COPY[apiError.code];
    return apiError?.message || fallback;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (isSignUp && !canSignUp) || (isForgot && !emailEnabled)) return;
    const nextEmail = email.trim();
    if (!nextEmail || (!isForgot && !password)) {
      setError(isForgot ? '请填写邮箱。' : '请填写邮箱和密码。');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      if (isForgot) {
        await requestPasswordReset(nextEmail);
        setNotice('如果该邮箱可接收账号邮件，请查收密码重置邮件。');
        return;
      }
      const user = isSignUp
        ? await registerAccount({ email: nextEmail, password, displayName: displayName.trim() || undefined })
        : await loginAccount(nextEmail, password);
      if (user) {
        onAuthenticated(user);
      } else {
        switchMode('sign-in');
        setPassword('');
        setDisplayName('');
        setNotice('请查收邮箱中的验证邮件，完成验证后登录。');
      }
    } catch (caught) {
      setError(isForgot ? '暂时无法处理请求，请稍后重试。' : describe(caught, isSignUp ? '注册失败，请稍后重试。' : '登录失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  }

  const title = isForgot ? '忘记密码' : isSignUp ? '创建账号' : '登录控制台';
  const description = isForgot ? '输入账号邮箱以申请重置密码。'
    : isSignUp ? (emailMode === 'enforce' ? '请先验证邮箱，再登录个人工作空间。' : '注册后自动创建你的个人组织并进入控制台。')
      : '使用邮箱继续，身份由服务端会话解析。';
  const submitLabel = isForgot ? '申请重置密码' : isSignUp ? (emailMode === 'enforce' ? '创建账号' : '创建账号并进入') : '登录';

  return (
    <AuthPage title={title} label={isSignUp ? '注册账号' : title} description={description}>
      {retryEmailConfig && <div>
        <p className="auth-error" role="alert">暂时无法读取邮箱认证配置。</p>
        <button type="button" className="button secondary auth-secondary" onClick={retryEmailConfig}>重试认证配置</button>
      </div>}
      {canSignUp && !isForgot && (
        <div className="auth-switch" role="tablist" aria-label="登录或注册">
          <button type="button" role="tab" aria-selected={!isSignUp} className={!isSignUp ? 'active' : ''} disabled={busy} onClick={() => switchMode('sign-in')}>登录</button>
          <button type="button" role="tab" aria-selected={isSignUp} className={isSignUp ? 'active' : ''} disabled={busy} onClick={() => switchMode('sign-up')}>注册</button>
        </div>
      )}

      <form onSubmit={submit} noValidate={!isForgot}>
        {isSignUp && (
          <label className="auth-field">
            <span>显示名称（可选）</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="用于控制台顶部展示" autoComplete="name" />
          </label>
        )}

        <label className="auth-field">
          <span>邮箱</span>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" autoComplete="email" required={isForgot} />
        </label>

        {!isForgot && (
          <label className="auth-field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={isSignUp ? '至少 12 位字符' : '请输入密码'}
              minLength={isSignUp ? 12 : undefined}
              maxLength={isSignUp ? 128 : undefined}
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
            />
          </label>
        )}

        {notice && <p className="auth-status" role="status">{notice}</p>}
        {error && <p className="auth-error" role="alert"><CircleAlert />{error}</p>}

        <button type="submit" className="button primary auth-submit" disabled={busy}>
          {busy && <LoaderCircle className="spin" />}
          {submitLabel}
          {!busy && <ArrowRight />}
        </button>
      </form>

      {isForgot && <button type="button" className="button secondary auth-secondary" disabled={busy} onClick={() => switchMode('sign-in')}>返回登录</button>}
      {mode === 'sign-in' && emailEnabled && <button type="button" className="button secondary auth-secondary" disabled={busy} onClick={() => switchMode('forgot')}>忘记密码</button>}

      {!isForgot && <>
        <div className="auth-divider"><span>或</span></div>
        <button type="button" className="button auth-sso" disabled title="企业 SSO 由 WorkOS 承接，待企业客户接入时开放">
          <Building2 />使用企业 SSO 登录
        </button>
      </>}
    </AuthPage>
  );
}
