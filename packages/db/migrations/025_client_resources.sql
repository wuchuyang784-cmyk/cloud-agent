-- BaiRui 客户端资源目录：知识库、Skill、工具、插件等由用户管理的业务资源。
-- 内容正文和文件索引后续可拆到独立表；本迁移先提供隔离的资源目录。
-- kind 覆盖客户端可挂载到 Agent 的四种资源类型，后续扩展类型时需同步
-- 更新 apps/platform-api/src/app.mjs 中的 RESOURCE_KINDS。
BEGIN;

CREATE TABLE IF NOT EXISTS client_resources (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('knowledge_base', 'skill', 'tool', 'plugin')),
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_members (organization_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS client_resources_owner_scope_idx
  ON client_resources (organization_id, owner_user_id, kind, updated_at DESC, id DESC);

ALTER TABLE client_resources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_resources_user_scope ON client_resources;
CREATE POLICY client_resources_user_scope ON client_resources
  USING (organization_id = current_setting('app.organization_id', true)
    AND owner_user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND owner_user_id = current_setting('app.user_id', true));

COMMIT;
