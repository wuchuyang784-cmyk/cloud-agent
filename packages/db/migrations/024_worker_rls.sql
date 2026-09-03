-- Worker 通过短事务领取跨组织 Outbox；业务 API 仍只使用用户范围上下文。
BEGIN;

DROP POLICY IF EXISTS control_outbox_worker_scope ON control_outbox;
CREATE POLICY control_outbox_worker_scope ON control_outbox
  USING (current_setting('app.worker_id', true) <> '')
  WITH CHECK (current_setting('app.worker_id', true) <> '');

DROP POLICY IF EXISTS agents_worker_scope ON agents;
CREATE POLICY agents_worker_scope ON agents
  USING (current_setting('app.worker_id', true) <> '')
  WITH CHECK (current_setting('app.worker_id', true) <> '');

DROP POLICY IF EXISTS runtime_routes_worker_scope ON runtime_routes;
CREATE POLICY runtime_routes_worker_scope ON runtime_routes
  USING (current_setting('app.worker_id', true) <> '')
  WITH CHECK (current_setting('app.worker_id', true) <> '');

COMMIT;
