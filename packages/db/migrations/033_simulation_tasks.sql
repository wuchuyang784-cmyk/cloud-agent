-- 仅模拟调度：应用范围与现有业务表保持一致，不修改已有任务或 Agent。
BEGIN;
CREATE TABLE simulation_tasks (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  "key" text NOT NULL,
  "durationMs" integer NOT NULL CHECK ("durationMs" BETWEEN 2000 AND 5000),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  "workerId" text,
  "leaseUntil" double precision,
  "createdAt" double precision NOT NULL,
  "updatedAt" double precision NOT NULL,
  FOREIGN KEY (organization_id,user_id) REFERENCES organization_members(organization_id,user_id),
  UNIQUE (organization_id,user_id,"key")
);
CREATE INDEX simulation_tasks_active ON simulation_tasks(status,"createdAt",id)
  WHERE status IN ('queued','running');
CREATE INDEX simulation_tasks_owner ON simulation_tasks(organization_id,user_id,"createdAt" DESC,id);
CREATE TABLE simulation_tenants (
  organization_id text NOT NULL,
  user_id text NOT NULL,
  served bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id,user_id),
  FOREIGN KEY (organization_id,user_id) REFERENCES organization_members(organization_id,user_id)
);
ALTER TABLE simulation_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY simulation_tasks_owner ON simulation_tasks
 USING (organization_id=current_setting('app.organization_id',true) AND user_id=current_setting('app.user_id',true))
 WITH CHECK (organization_id=current_setting('app.organization_id',true) AND user_id=current_setting('app.user_id',true));
CREATE POLICY simulation_tasks_worker ON simulation_tasks
 USING (current_setting('app.simulation_worker',true)='on')
 WITH CHECK (current_setting('app.simulation_worker',true)='on');
ALTER TABLE simulation_tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY simulation_tenants_worker ON simulation_tenants
 USING (current_setting('app.simulation_worker',true)='on')
 WITH CHECK (current_setting('app.simulation_worker',true)='on');
REVOKE ALL ON simulation_tasks,simulation_tenants FROM PUBLIC;
COMMIT;
