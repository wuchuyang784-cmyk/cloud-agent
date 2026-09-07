-- 客户端控制台用户功能：我的收藏、通知、设置、费用中心（充值/扣费）、备案。
-- 全部以 (organization_id, user_id) 为用户范围并启用 RLS；跨用户/跨组织默认不可见。
BEGIN;

-- 1. 我的收藏：Agent / 客户端业务资源快捷入口（target 为软引用，删除目标后过滤）。
CREATE TABLE IF NOT EXISTS user_favorites (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('agent', 'resource')),
  target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_members (organization_id, user_id) ON DELETE CASCADE,
  UNIQUE (organization_id, user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS user_favorites_user_idx
  ON user_favorites (organization_id, user_id, created_at DESC, id DESC);

-- 2. 站内通知：系统/计费/Agent/资源事件。
CREATE TABLE IF NOT EXISTS user_notifications (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'system'
    CHECK (type IN ('system', 'billing', 'agent', 'resource')),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_members (organization_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_notifications_user_idx
  ON user_notifications (organization_id, user_id, is_read, created_at DESC, id DESC);

-- 3. 用户偏好设置（昵称 + JSON 偏好）。
CREATE TABLE IF NOT EXISTS user_settings (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text,
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

-- 4. 费用中心：账户余额与账单流水（充值/扣费）。金额单位：分。
CREATE TABLE IF NOT EXISTS user_accounts (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  balance_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'CNY',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS account_transactions (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('recharge', 'consume')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  balance_after_cents bigint NOT NULL,
  reference_type text,
  reference_id text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_members (organization_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS account_transactions_user_idx
  ON account_transactions (organization_id, user_id, created_at DESC, id DESC);

-- 5. 备案信息：Agent 对外提供服务的 ICP/合规备案主体记录。
CREATE TABLE IF NOT EXISTS icp_filings (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  domain text NOT NULL,
  subject_name text NOT NULL,
  subject_type text NOT NULL DEFAULT 'enterprise'
    CHECK (subject_type IN ('enterprise', 'individual')),
  icp_number text,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_members (organization_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS icp_filings_owner_idx
  ON icp_filings (organization_id, owner_user_id, created_at DESC, id DESC);

-- RLS：所有表按当前会话 app.organization_id / app.user_id 限定。
ALTER TABLE user_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_filings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_favorites_user_scope ON user_favorites;
CREATE POLICY user_favorites_user_scope ON user_favorites
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS user_notifications_user_scope ON user_notifications;
CREATE POLICY user_notifications_user_scope ON user_notifications
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS user_settings_user_scope ON user_settings;
CREATE POLICY user_settings_user_scope ON user_settings
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS user_accounts_user_scope ON user_accounts;
CREATE POLICY user_accounts_user_scope ON user_accounts
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS account_transactions_user_scope ON account_transactions;
CREATE POLICY account_transactions_user_scope ON account_transactions
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS icp_filings_user_scope ON icp_filings;
CREATE POLICY icp_filings_user_scope ON icp_filings
  USING (organization_id = current_setting('app.organization_id', true)
    AND owner_user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND owner_user_id = current_setting('app.user_id', true));

COMMIT;
