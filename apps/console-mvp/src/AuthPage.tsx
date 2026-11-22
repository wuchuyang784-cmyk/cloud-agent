import type { ReactNode } from 'react';

export function AuthPage({ title, description, label = title, children }: {
  title: string;
  description?: string;
  label?: string;
  children: ReactNode;
}) {
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
        <section className="auth-card" aria-label={label}>
          <header className="auth-card-head">
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </header>
          {children}
        </section>
      </main>
    </div>
  );
}
