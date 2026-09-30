-- D2 账号治理执行闭环：把治理版本与取消原因持久化到模拟调度任务。
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE simulation_tasks
  ADD COLUMN IF NOT EXISTS governance_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

UPDATE simulation_tasks
SET cancel_reason = 'user_requested',
    cancelled_at = to_timestamp("updatedAt" / 1000.0)
WHERE status = 'cancelled'
  AND (cancel_reason IS NULL OR cancelled_at IS NULL);

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simulation_tasks_governance_version_check') THEN
    ALTER TABLE simulation_tasks ADD CONSTRAINT simulation_tasks_governance_version_check
      CHECK (governance_version >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simulation_tasks_cancel_reason_check') THEN
    ALTER TABLE simulation_tasks ADD CONSTRAINT simulation_tasks_cancel_reason_check
      CHECK (cancel_reason IS NULL OR cancel_reason IN ('user_requested', 'account_suspended', 'account_banned', 'governance_changed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simulation_tasks_cancelled_fields_check') THEN
    ALTER TABLE simulation_tasks ADD CONSTRAINT simulation_tasks_cancelled_fields_check
      CHECK ((status = 'cancelled' AND cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL)
        OR (status <> 'cancelled' AND cancel_reason IS NULL AND cancelled_at IS NULL));
  END IF;
END
$constraints$;

DO $migration$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_scheduler_account_access(p_user text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    SET row_security = off AS $body$
      SELECT %1$I.platform_account_access(p_user)
    $body$
  $definition$, s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_scheduler_account_access(text) FROM PUBLIC', s);
END
$migration$;
COMMIT;