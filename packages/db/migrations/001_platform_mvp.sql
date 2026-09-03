-- BaiRui 平台 MVP 控制平面数据库结构。
-- 请使用具备迁移权限的角色导入。应用角色不能是 PostgreSQL 超级用户，
-- 也不能拥有 BYPASSRLS 权限。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text,
  auth_subject text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'org_admin', 'platform_admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL,
  description text,
  status text NOT NULL CHECK (status IN ('uninitialized', 'provisioning', 'starting', 'ready', 'degraded', 'offline', 'failed', 'stopped')),
  runtime_kind text NOT NULL DEFAULT 'mock',
  host text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agents_owner_scope_idx
  ON agents (organization_id, owner_user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_memberships (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'operator', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, user_id),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_members (organization_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_memberships_user_scope_idx
  ON agent_memberships (organization_id, user_id, agent_id);

CREATE TABLE IF NOT EXISTS runtime_routes (
  agent_id text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  runtime_url text NOT NULL,
  route_version bigint NOT NULL DEFAULT 1,
  health_status text NOT NULL DEFAULT 'unknown',
  last_seen_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions_projection (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title text,
  runtime_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, agent_id, id)
);

CREATE INDEX IF NOT EXISTS sessions_user_scope_idx
  ON sessions_projection (organization_id, user_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id text REFERENCES sessions_projection(id) ON DELETE SET NULL,
  model text,
  calls integer NOT NULL DEFAULT 1 CHECK (calls >= 0),
  failed_calls integer NOT NULL DEFAULT 0 CHECK (failed_calls >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS usage_events_user_time_idx
  ON usage_events (organization_id, user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_agent_time_idx
  ON usage_events (organization_id, agent_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS usage_rollups (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  model text NOT NULL DEFAULT 'unknown',
  total_calls bigint NOT NULL DEFAULT 0,
  failed_calls bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  total_latency_ms bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, agent_id, bucket_start, model)
);

CREATE INDEX IF NOT EXISTS usage_rollups_user_time_idx
  ON usage_rollups (organization_id, user_id, bucket_start DESC);

CREATE TABLE IF NOT EXISTS control_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  leased_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS control_outbox_lease_idx
  ON control_outbox (status, available_at, lease_until, created_at);
CREATE INDEX IF NOT EXISTS control_outbox_aggregate_idx
  ON control_outbox (organization_id, aggregate_type, aggregate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (organization_id, user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_scope_time_idx
  ON audit_events (organization_id, created_at DESC);

-- 纵深防御：应用代码在每次查询前仍必须解析 Principal 并校验数据范围，
-- 包括 Runtime 和对象存储操作。
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agents_user_scope ON agents;
CREATE POLICY agents_user_scope ON agents
  USING (organization_id = current_setting('app.organization_id', true)
    AND owner_user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND owner_user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS agent_memberships_user_scope ON agent_memberships;
CREATE POLICY agent_memberships_user_scope ON agent_memberships
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS sessions_user_scope ON sessions_projection;
CREATE POLICY sessions_user_scope ON sessions_projection
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS usage_events_user_scope ON usage_events;
CREATE POLICY usage_events_user_scope ON usage_events
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS usage_rollups_user_scope ON usage_rollups;
CREATE POLICY usage_rollups_user_scope ON usage_rollups
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS audit_events_user_scope ON audit_events;
CREATE POLICY audit_events_user_scope ON audit_events
  USING (organization_id = current_setting('app.organization_id', true));

DROP POLICY IF EXISTS control_outbox_org_scope ON control_outbox;
CREATE POLICY control_outbox_org_scope ON control_outbox
  USING (organization_id = current_setting('app.organization_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true));

DROP POLICY IF EXISTS runtime_routes_org_scope ON runtime_routes;
CREATE POLICY runtime_routes_org_scope ON runtime_routes
  USING (organization_id = current_setting('app.organization_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true));

DROP POLICY IF EXISTS idempotency_keys_user_scope ON idempotency_keys;
CREATE POLICY idempotency_keys_user_scope ON idempotency_keys
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));
