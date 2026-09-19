import { ArrowRight, Building2, CircleAlert, LoaderCircle } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { loginAccount, registerAccount, type ApiError, type User } from './api';

type Mode = 'sign-in' | 'sign-up';

// 服务端错误码到用户可读文案的映射（docs/30 §9 错误码表）。
const ERROR_COPY: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确，请重试。',
  USER_ALREADY_EXISTS: '该邮箱已注册，请直接登录。',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: '该邮箱已注册，请直接登录。',
  PASSWORD_TOO_SHORT: '密码至少需要 12 位字符。',
  PASSWORD_TOO_LONG: '密码不能超过 128 位字符。',
  TOO_MANY_REQUESTS: '操作过于频繁，请稍后再试。',
  identity_link_required: '此邮箱已有历史账号，请联系平台负责人核验并迁移，原数据不会自动合并。',
  invalid_credentials: '邮箱或密码不正确，请重试。',
  email_taken: '该邮箱已注册，请直接登录。',
  validation_error: '请检查填写内容是否符合要求。',
  unauthenticated: '登录状态已失效，请重新登录。',
  database_unavailable: '服务暂时不可用，请稍后再试。',
};

export function LoginPage({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSignUp = mode === 'sign-up';

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  function describe(caught: unknown, fallback: string): string {
    const apiError = caught as ApiError;
    if (apiError?.code && ERROR_COPY[apiError.code]) return ERROR_COPY[apiError.code];
    return apiError?.message || fallback;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const nextEmail = email.trim();
    if (!nextEmail || !password) {
      setError('请填写邮箱和密码。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = isSignUp
        ? await registerAccount({ email: nextEmail, password, displayName: displayName.trim() || undefined })
        : await loginAccount(nextEmail, password);
      onAuthenticated(user);
    } catch (caught) {
      setError(describe(caught, isSignUp ? '注册失败，请稍后重试。' : '登录失败，请稍后重试。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <div className="auth-brand">
          <span className="auth-mark">BR</span>
          <div>
            <strong>BaiRui</strong>
            <small>Agent Cloud</small>
          </div>
        </div>

        <div className="auth-pitch">
          <span className="auth-eyebrow">个人工作空间</span>
          <h1>BaiRui 云平台</h1>
        </div>

        <p className="auth-footnote">登录即表示同意平台的服务条款与隐私政策。</p>
      </aside>

      <main className="auth-main">
        <section className="auth-card" aria-label={isSignUp ? '注册账号' : '登录控制台'}>
          <header className="auth-card-head">
            <h2>{isSignUp ? '创建账号' : '登录控制台'}</h2>
            <p>{isSignUp ? '注册后自动创建你的个人组织并进入控制台。' : '使用邮箱继续，身份由服务端会话解析。'}</p>
          </header>

          <div className="auth-switch" role="tablist" aria-label="登录或注册">
            <button type="button" role="tab" aria-selected={!isSignUp} className={!isSignUp ? 'active' : ''} onClick={() => switchMode('sign-in')}>登录</button>
            <button type="button" role="tab" aria-selected={isSignUp} className={isSignUp ? 'active' : ''} onClick={() => switchMode('sign-up')}>注册</button>
          </div>

          <form onSubmit={submit} noValidate>
            {isSignUp ? (
              <label className="auth-field">
                <span>显示名称（可选）</span>
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="用于控制台顶部展示" autoComplete="name" />
              </label>
            ) : null}

            <label className="auth-field">
              <span>邮箱</span>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" autoComplete="email" />
            </label>

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

            {error ? <p className="auth-error" role="alert"><CircleAlert />{error}</p> : null}

            <button type="submit" className="button primary auth-submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" /> : null}
              {isSignUp ? '创建账号并进入' : '登录'}
              {busy ? null : <ArrowRight />}
            </button>
          </form>

          <div className="auth-divider"><span>或</span></div>

          <button type="button" className="button auth-sso" disabled title="企业 SSO 由 WorkOS 承接，待企业客户接入时开放">
            <Building2 />使用企业 SSO 登录
          </button>

        </section>
      </main>
    </div>
  );
}
