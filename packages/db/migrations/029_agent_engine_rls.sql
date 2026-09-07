-- 引擎与模板库 RLS 修复。
-- 背景：
--  1) agents 表 policy（001 user_scope / 024 worker_scope）已存在，但实际库中
--     agents 的 ROW LEVEL SECURITY 处于关闭状态（导入顺序/人工操作导致），
--     导致用户与组织隔离策略空转，本迁移强制恢复启用；
--  2) 022 新增的 agent_templates / agent_template_installs / agent_engine_runs /
--     agent_memory_entries 四表未启用 RLS，与 025-028「新表自带 RLS + scope 策略」
--     约定不一致，本迁移补齐。
-- 全部 DROP POLICY IF EXISTS + CREATE，可重复执行。
BEGIN;

-- 1. agents：恢复行级安全（001/024 的策略随之生效）
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

-- 2. agent_templates：官方模板（organization_id IS NULL）对全体只读；
--    组织模板仅同组织可见；普通会话只能写自己组织的模板（官方模板由迁移/管理端维护）。
ALTER TABLE agent_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_templates_read ON agent_templates;
CREATE POLICY agent_templates_read ON agent_templates FOR SELECT
  USING (organization_id IS NULL
    OR organization_id = current_setting('app.organization_id', true));

DROP POLICY IF EXISTS agent_templates_insert ON agent_templates;
CREATE POLICY agent_templates_insert ON agent_templates FOR INSERT
  WITH CHECK (organization_id = current_setting('app.organization_id', true));

DROP POLICY IF EXISTS agent_templates_update ON agent_templates;
CREATE POLICY agent_templates_update ON agent_templates FOR UPDATE
  USING (organization_id = current_setting('app.organization_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true));

DROP POLICY IF EXISTS agent_templates_delete ON agent_templates;
CREATE POLICY agent_templates_delete ON agent_templates FOR DELETE
  USING (organization_id = current_setting('app.organization_id', true));

-- 3. agent_template_installs：模板派生记录按 组织 + 用户 隔离
ALTER TABLE agent_template_installs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_template_installs_user_scope ON agent_template_installs;
CREATE POLICY agent_template_installs_user_scope ON agent_template_installs
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

-- 4. agent_engine_runs：普通会话只能访问自己拥有（owner_user_id）Agent 的运行记录；
--    Worker 按 app.worker_id 跨组织管理（与 024 模式一致）。
ALTER TABLE agent_engine_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_engine_runs_user_scope ON agent_engine_runs;
CREATE POLICY agent_engine_runs_user_scope ON agent_engine_runs
  USING (organization_id = current_setting('app.organization_id', true)
    AND EXISTS (
      SELECT 1 FROM agents a
      WHERE a.id = agent_engine_runs.agent_id
        AND a.owner_user_id = current_setting('app.user_id', true)))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND EXISTS (
      SELECT 1 FROM agents a
      WHERE a.id = agent_engine_runs.agent_id
        AND a.owner_user_id = current_setting('app.user_id', true)));

DROP POLICY IF EXISTS agent_engine_runs_worker_scope ON agent_engine_runs;
CREATE POLICY agent_engine_runs_worker_scope ON agent_engine_runs
  USING (current_setting('app.worker_id', true) <> '')
  WITH CHECK (current_setting('app.worker_id', true) <> '');

-- 5. agent_memory_entries：同 agent_engine_runs（Agent 归属 + Worker 管理）
ALTER TABLE agent_memory_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_memory_entries_user_scope ON agent_memory_entries;
CREATE POLICY agent_memory_entries_user_scope ON agent_memory_entries
  USING (organization_id = current_setting('app.organization_id', true)
    AND EXISTS (
      SELECT 1 FROM agents a
      WHERE a.id = agent_memory_entries.agent_id
        AND a.owner_user_id = current_setting('app.user_id', true)))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND EXISTS (
      SELECT 1 FROM agents a
      WHERE a.id = agent_memory_entries.agent_id
        AND a.owner_user_id = current_setting('app.user_id', true)));

DROP POLICY IF EXISTS agent_memory_entries_worker_scope ON agent_memory_entries;
CREATE POLICY agent_memory_entries_worker_scope ON agent_memory_entries
  USING (current_setting('app.worker_id', true) <> '')
  WITH CHECK (current_setting('app.worker_id', true) <> '');

COMMIT;
