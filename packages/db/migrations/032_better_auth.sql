-- Better Auth 1.7.5 专用认证表，与平台 users / auth_sessions 分开。
-- 先执行 031；不迁移旧密码，不按邮箱自动绑定身份。请先备份数据库。
-- 认证服务需要跨用户查询凭据，因此这些表不使用业务 RLS；仅后端账号可访问。
BEGIN;

CREATE TABLE ba_user (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE TABLE ba_session (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES ba_user(id) ON DELETE CASCADE
);
CREATE INDEX ba_session_user_idx ON ba_session ("userId");
CREATE INDEX ba_session_expiry_idx ON ba_session ("expiresAt");
CREATE TABLE ba_account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES ba_user(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  UNIQUE ("providerId", "accountId")
);
CREATE INDEX ba_account_user_idx ON ba_account ("userId");
CREATE TABLE ba_verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX ba_verification_identifier_idx ON ba_verification (identifier);
CREATE TABLE ba_rate_limit (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  "lastRequest" bigint NOT NULL
);
REVOKE ALL ON ba_user, ba_session, ba_account, ba_verification, ba_rate_limit FROM PUBLIC;
COMMIT;
