-- 双引擎平台建设：Agent 模板库与引擎运行记录（28 号文档 §1 落地）。
-- 基线：001_platform_mvp.sql（12 表）。本迁移全部 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS，可重复执行。
-- 说明：仓库基线为 001（无 005/015/017 等历史迁移），故仅新增模板库 4 表 + agents 引擎绑定列，
--       不做 Hermes 记忆列废弃与 memory_projection_outbox 枚举扩展。

BEGIN;

-- 1.1 新表：agent_templates（模板库，平台一等资源，存声明式 manifest）
CREATE TABLE IF NOT EXISTS agent_templates (
  id               text PRIMARY KEY,
  organization_id  text REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = 官方/平台模板
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  engine           text NOT NULL CHECK (engine IN ('pi', 'dsh')),
  manifest         jsonb NOT NULL,           -- 27 号 §3.1 的完整 manifest
  version          integer NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'published', 'archived')),
  source           text NOT NULL DEFAULT 'official'
                   CHECK (source IN ('official', 'ecosystem', 'user')),
  upstream_ref     text,                     -- 引擎生态模板来源：preset/Bundle 名称+版本
  fork_of          text REFERENCES agent_templates(id) ON DELETE SET NULL,
  engine_config    jsonb NOT NULL DEFAULT '{}'::jsonb, -- 拉取/校验缓存的引擎配置快照
  created_by       text REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_templates_lookup_idx
  ON agent_templates (status, engine, source);

CREATE INDEX IF NOT EXISTS agent_templates_org_idx
  ON agent_templates (organization_id) WHERE organization_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agent_templates_org_name_version_idx
  ON agent_templates (organization_id, name, version)
  WHERE organization_id IS NOT NULL;

-- 1.2 agents 表新增列：引擎绑定（模板版本可换，引擎不可换）
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'dsh'
    CHECK (engine IN ('pi', 'dsh')),
  ADD COLUMN IF NOT EXISTS template_id text REFERENCES agent_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_version integer;

-- 1.3 新表：agent_template_installs（模板派生/订阅，支撑市场统计与升级提示）
CREATE TABLE IF NOT EXISTS agent_template_installs (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id      text NOT NULL REFERENCES agent_templates(id) ON DELETE CASCADE,
  agent_id         text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  template_version integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id)
);

-- 1.4 新表：agent_engine_runs（引擎实例 spawn/stop 状态机，供网关路由/控制面/运维观测）
CREATE TABLE IF NOT EXISTS agent_engine_runs (
  id                text PRIMARY KEY,
  organization_id   text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id          text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  engine            text NOT NULL CHECK (engine IN ('pi', 'dsh')),
  template_version  integer NOT NULL,
  status            text NOT NULL DEFAULT 'initializing'
                    CHECK (status IN ('initializing', 'running', 'degraded', 'stopped', 'failed', 'deleting')),
  container_ref     text,                     -- 容器/服务引用（Swarm service 名、container id）
  runtime_url       text,                     -- 内部反代地址（http://host:port）
  subdomain         text NOT NULL,            -- agent-{id}.bairui.app（25 号 §3.1）
  engine_pid        integer,
  last_error_code   text,
  last_error_detail text,
  desired_state     text NOT NULL DEFAULT 'stopped'
                    CHECK (desired_state IN ('running', 'stopped', 'deleting')),
  started_at        timestamptz,
  stopped_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_engine_runs_agent_latest_idx
  ON agent_engine_runs (agent_id, created_at DESC);

-- 1.5 新表：agent_memory_entries（引擎无关记忆投影目标）
CREATE TABLE IF NOT EXISTS agent_memory_entries (
  id               text PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id         text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  engine           text NOT NULL CHECK (engine IN ('pi', 'dsh')),
  kind             text NOT NULL DEFAULT 'knowledge'
                   CHECK (kind IN ('knowledge','fact','preference','constraint','procedure','person','project','event')),
  content          text NOT NULL,
  importance       smallint NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  source           text NOT NULL CHECK (source IN ('session-log', 'config', 'platform')),
  retention_days   integer,                    -- NULL = 跟随模板 memory.retentionDays
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_memory_entries_agent_idx
  ON agent_memory_entries (agent_id, importance DESC, updated_at DESC);

COMMIT;
