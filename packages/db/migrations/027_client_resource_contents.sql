-- 客户端资源内容正文：承载知识库、Skill、工具、插件等资源的内容条目。
-- 基线：025_client_resources.sql（client_resources 目录表）。
-- 一条内容 = 一行，kind 区分 text/markdown/file_ref/json，后续可承载文件索引。
-- 全部 IF NOT EXISTS，可重复执行。
BEGIN;

CREATE TABLE IF NOT EXISTS client_resource_contents (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id text NOT NULL REFERENCES client_resources(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'text'
    CHECK (kind IN ('text', 'markdown', 'file_ref', 'json')),
  content text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, owner_user_id)
    REFERENCES organization_members (organization_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS client_resource_contents_owner_scope_idx
  ON client_resource_contents (organization_id, owner_user_id, resource_id, created_at, id);

ALTER TABLE client_resource_contents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_resource_contents_user_scope ON client_resource_contents;
CREATE POLICY client_resource_contents_user_scope ON client_resource_contents
  USING (organization_id = current_setting('app.organization_id', true)
    AND owner_user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND owner_user_id = current_setting('app.user_id', true));

COMMIT;
