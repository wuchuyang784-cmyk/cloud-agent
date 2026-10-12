-- E1 真实 Runtime 控制安全：持久代次、幂等命令、强停确认与治理协调。
-- 依赖基础表及 022/029/036/037；不依赖模拟任务 033/038，不开放用户执行入口。
BEGIN;

ALTER TABLE agent_engine_runs
  ADD COLUMN IF NOT EXISTS run_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_reason text,
  ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS stop_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_command_request_id uuid;

ALTER TABLE agent_engine_runs DROP CONSTRAINT IF EXISTS agent_engine_runs_status_check;
ALTER TABLE agent_engine_runs ADD CONSTRAINT agent_engine_runs_status_check
  CHECK (status IN ('initializing','running','degraded','stopping','stopped','failed','deleting'));

CREATE UNIQUE INDEX IF NOT EXISTS agent_engine_runs_generation_uidx
  ON agent_engine_runs(agent_id,run_generation) WHERE run_generation > 0;
CREATE UNIQUE INDEX IF NOT EXISTS agent_engine_runs_agent_id_uidx
  ON agent_engine_runs(agent_id,id);

ALTER TABLE control_outbox ADD COLUMN IF NOT EXISTS request_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS control_outbox_request_uidx
  ON control_outbox(request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_runtime_controls (
  agent_id text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  desired_state text NOT NULL CHECK (desired_state IN ('running','stopped')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  active_run_id text,
  cpu_millis integer NOT NULL CHECK (cpu_millis BETWEEN 100 AND 8000),
  memory_bytes bigint NOT NULL CHECK (memory_bytes BETWEEN 134217728 AND 17179869184),
  pids_limit integer NOT NULL CHECK (pids_limit BETWEEN 16 AND 1024),
  idle_ttl_seconds integer NOT NULL CHECK (idle_ttl_seconds BETWEEN 60 AND 86400),
  last_request_id uuid,
  changed_by text REFERENCES users(id) ON DELETE SET NULL,
  change_reason text NOT NULL CHECK (length(change_reason) BETWEEN 1 AND 500 AND change_reason !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='agent_runtime_controls'::regclass
      AND conname='agent_runtime_controls_active_run_fk'
  ) THEN
    ALTER TABLE agent_runtime_controls
      ADD CONSTRAINT agent_runtime_controls_active_run_fk
      FOREIGN KEY(agent_id,active_run_id)
      REFERENCES agent_engine_runs(agent_id,id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$constraint$;

CREATE INDEX IF NOT EXISTS agent_runtime_controls_owner_idx
  ON agent_runtime_controls(owner_user_id,agent_id);
ALTER TABLE agent_runtime_controls ADD COLUMN IF NOT EXISTS governance_version integer NOT NULL DEFAULT 0 CHECK (governance_version>=0);

CREATE TABLE IF NOT EXISTS agent_runtime_control_requests (
  request_id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('start','stop','governance_stop','recovery_stop')),
  request_hash text NOT NULL,
  expected_generation bigint NOT NULL CHECK (expected_generation >= 0),
  result_generation bigint NOT NULL CHECK (result_generation >= 0),
  result_code text NOT NULL CHECK (result_code IN ('accepted','noop')),
  run_id text,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_runtime_control_requests DROP CONSTRAINT IF EXISTS agent_runtime_control_requests_action_check;
ALTER TABLE agent_runtime_control_requests ADD CONSTRAINT agent_runtime_control_requests_action_check
  CHECK(action IN ('start','stop','governance_stop','recovery_stop'));

CREATE INDEX IF NOT EXISTS agent_runtime_control_requests_agent_idx
  ON agent_runtime_control_requests(agent_id,result_generation,action,occurred_at DESC);

ALTER TABLE agent_runtime_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runtime_controls FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_runtime_control_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runtime_control_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_runtime_controls_user_read ON agent_runtime_controls;
CREATE POLICY agent_runtime_controls_user_read ON agent_runtime_controls
  FOR SELECT USING (
    organization_id=current_setting('app.organization_id',true)
    AND owner_user_id=current_setting('app.user_id',true)
  );

DROP POLICY IF EXISTS agent_runtime_control_requests_user_read ON agent_runtime_control_requests;
CREATE POLICY agent_runtime_control_requests_user_read ON agent_runtime_control_requests
  FOR SELECT USING (
    organization_id=current_setting('app.organization_id',true)
    AND EXISTS (
      SELECT 1 FROM agents a
      WHERE a.id=agent_runtime_control_requests.agent_id
        AND a.owner_user_id=current_setting('app.user_id',true)
    )
  );

REVOKE ALL ON agent_runtime_controls,agent_runtime_control_requests FROM PUBLIC;

DO $migration$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_control_receipt(
      p_worker text,p_request uuid,p_attempt integer,p_event text,p_agent text,p_run text,p_generation bigint,p_fence bigint
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE q record;
    BEGIN
      SELECT * INTO q FROM %1$I.control_outbox WHERE request_id=p_request FOR UPDATE;
      RETURN coalesce(q.status='leased' AND q.leased_by=p_worker AND q.attempts=p_attempt AND q.lease_until>clock_timestamp()
        AND q.event_type=p_event AND q.aggregate_id=p_agent AND q.payload->>'agentId'=p_agent
        AND q.payload->>'runId'=p_run AND (q.payload->>'runGeneration')::bigint=p_generation
        AND (p_event='runtime.start.requested' OR (q.payload->>'fenceGeneration')::bigint=p_fence),false);
    END $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_control_prepare(p_worker text,p_request uuid,p_attempt integer)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE q record; c record; g jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      SELECT * INTO q FROM %1$I.control_outbox WHERE request_id=p_request;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','runtime_command_lease_lost'); END IF;
      SELECT * INTO c FROM %1$I.agent_runtime_controls WHERE agent_id=q.aggregate_id FOR UPDATE;
      IF NOT %1$I.runtime_control_receipt(p_worker,p_request,p_attempt,q.event_type,q.aggregate_id,
        q.payload->>'runId',(q.payload->>'runGeneration')::bigint,(q.payload->>'fenceGeneration')::bigint)
        THEN RETURN jsonb_build_object('error','runtime_command_lease_lost'); END IF;
      IF q.event_type='runtime.stop.requested' THEN RETURN jsonb_build_object('eligible',true); END IF;
      g := %1$I.platform_account_access(c.owner_user_id);
      IF g IS NULL THEN RAISE EXCEPTION 'governance_unavailable'; END IF;
      IF c.desired_state='running' AND c.active_run_id=q.payload->>'runId' AND c.generation=(q.payload->>'runGeneration')::bigint
        AND g->>'status'='active' AND (g->>'version')::integer=c.governance_version THEN
        RETURN jsonb_build_object('eligible',true);
      END IF;
      RETURN jsonb_build_object('eligible',false,'reason','superseded');
    END $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_control_request_start(
      p_actor text,p_agent text,p_request uuid,p_expected bigint,
      p_cpu integer,p_memory bigint,p_pids integer,p_idle integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE a record; c record; replay record; v_hash text; v_generation bigint; v_run text; v_result jsonb; v_governance jsonb;
    BEGIN
      IF p_actor IS NULL OR p_agent IS NULL OR p_request IS NULL OR p_expected IS NULL OR p_expected<0
        OR p_cpu IS NULL OR p_memory IS NULL OR p_pids IS NULL OR p_idle IS NULL
        OR p_cpu NOT BETWEEN 100 AND 8000 OR p_memory NOT BETWEEN 134217728 AND 17179869184
        OR p_pids NOT BETWEEN 16 AND 1024 OR p_idle NOT BETWEEN 60 AND 86400
      THEN RAISE EXCEPTION 'runtime_control_invalid' USING ERRCODE='22023'; END IF;

      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:runtime:request:'||p_request::text,0));
      SELECT * INTO a FROM %1$I.agents WHERE id=p_agent AND owner_user_id=p_actor FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','runtime_agent_not_found'); END IF;
      IF a.engine NOT IN ('pi','dsh') THEN RETURN jsonb_build_object('error','runtime_engine_invalid'); END IF;
      v_governance := %1$I.platform_account_access(a.owner_user_id);
      IF v_governance->>'status' IS DISTINCT FROM 'active'
        THEN RETURN jsonb_build_object('error','account_runtime_forbidden'); END IF;

      v_hash := md5(jsonb_build_object('action','start','agentId',p_agent,'expectedGeneration',p_expected,
        'cpuMillis',p_cpu,'memoryBytes',p_memory,'pidsLimit',p_pids,'idleTtlSeconds',p_idle)::text);
      SELECT * INTO replay FROM %1$I.agent_runtime_control_requests WHERE request_id=p_request;
      IF FOUND THEN
        IF replay.request_hash<>v_hash THEN RETURN jsonb_build_object('error','idempotency_conflict'); END IF;
        RETURN jsonb_build_object('result',replay.result_code,'generation',replay.result_generation,
          'runId',replay.run_id,'replayed',true,'commandRequestId',
          CASE WHEN replay.result_code='accepted' AND replay.run_id IS NOT NULL THEN replay.request_id ELSE NULL END);
      END IF;

      SELECT * INTO c FROM %1$I.agent_runtime_controls WHERE agent_id=p_agent FOR UPDATE;
      IF p_expected<>coalesce(c.generation,0) THEN RETURN jsonb_build_object('error','runtime_generation_conflict'); END IF;
      IF c.desired_state='running' THEN
        IF c.governance_version<>(v_governance->>'version')::integer THEN RETURN jsonb_build_object('error','account_runtime_forbidden'); END IF;
        v_result := jsonb_build_object('result','noop','generation',c.generation,'runId',c.active_run_id,'replayed',false,'commandRequestId',NULL);
        UPDATE %1$I.agent_runtime_controls SET last_request_id=p_request,updated_at=clock_timestamp() WHERE agent_id=p_agent;
        INSERT INTO %1$I.agent_runtime_control_requests(request_id,organization_id,agent_id,action,request_hash,
          expected_generation,result_generation,result_code,run_id,actor_user_id,reason)
          VALUES(p_request,a.organization_id,p_agent,'start',v_hash,p_expected,c.generation,'noop',c.active_run_id,p_actor,'already_running');
        RETURN v_result;
      END IF;
      IF c.active_run_id IS NOT NULL THEN RETURN jsonb_build_object('error','runtime_stop_pending'); END IF;

      v_generation := coalesce(c.generation,0)+1;
      v_run := 'run-'||gen_random_uuid()::text;
      IF c.agent_id IS NULL THEN
        INSERT INTO %1$I.agent_runtime_controls(agent_id,organization_id,owner_user_id,desired_state,generation,
          active_run_id,cpu_millis,memory_bytes,pids_limit,idle_ttl_seconds,last_request_id,changed_by,change_reason)
          VALUES(p_agent,a.organization_id,a.owner_user_id,'running',v_generation,v_run,p_cpu,p_memory,p_pids,p_idle,p_request,p_actor,'start');
      ELSE
        UPDATE %1$I.agent_runtime_controls SET desired_state='running',generation=v_generation,active_run_id=v_run,
          cpu_millis=p_cpu,memory_bytes=p_memory,pids_limit=p_pids,idle_ttl_seconds=p_idle,last_request_id=p_request,
          changed_by=p_actor,change_reason='start',updated_at=clock_timestamp() WHERE agent_id=p_agent;
      END IF;
      UPDATE %1$I.agent_runtime_controls SET governance_version=(v_governance->>'version')::integer WHERE agent_id=p_agent;
      DELETE FROM %1$I.runtime_routes WHERE agent_id=p_agent;
      INSERT INTO %1$I.agent_engine_runs(id,organization_id,agent_id,engine,template_version,status,subdomain,
        desired_state,run_generation,last_command_request_id)
        VALUES(v_run,a.organization_id,p_agent,a.engine,coalesce(a.template_version,1),'initializing',a.host,
          'running',v_generation,p_request);
      INSERT INTO %1$I.control_outbox(organization_id,aggregate_type,aggregate_id,event_type,payload,request_id)
        VALUES(a.organization_id,'runtime',p_agent,'runtime.start.requested',jsonb_build_object(
          'agentId',p_agent,'runId',v_run,'runGeneration',v_generation,'engine',a.engine,'resourceSpec',jsonb_build_object(
            'cpuMillis',p_cpu,'memoryBytes',p_memory,'pidsLimit',p_pids,'idleTtlSeconds',p_idle)),p_request);
      INSERT INTO %1$I.agent_runtime_control_requests(request_id,organization_id,agent_id,action,request_hash,
        expected_generation,result_generation,result_code,run_id,actor_user_id,reason)
        VALUES(p_request,a.organization_id,p_agent,'start',v_hash,p_expected,v_generation,'accepted',v_run,p_actor,'start');
      RETURN jsonb_build_object('result','accepted','generation',v_generation,'runId',v_run,'replayed',false,'commandRequestId',p_request);
    END
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_control_request_stop(
      p_actor text,p_agent text,p_request uuid,p_expected bigint,p_reason text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE a record; c record; r record; replay record; v_hash text; v_reason text; v_generation bigint; v_result jsonb;
    BEGIN
      v_reason := btrim(p_reason);
      IF p_actor IS NULL OR p_agent IS NULL OR p_request IS NULL OR p_expected IS NULL OR p_expected<0
        OR v_reason IS NULL OR length(v_reason) NOT BETWEEN 1 AND 500 OR v_reason ~ '[[:cntrl:]]'
      THEN RAISE EXCEPTION 'runtime_control_invalid' USING ERRCODE='22023'; END IF;
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:runtime:request:'||p_request::text,0));
      SELECT * INTO a FROM %1$I.agents WHERE id=p_agent AND owner_user_id=p_actor FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','runtime_agent_not_found'); END IF;
      v_hash := md5(jsonb_build_object('action','stop','agentId',p_agent,'expectedGeneration',p_expected,'reason',v_reason)::text);
      SELECT * INTO replay FROM %1$I.agent_runtime_control_requests WHERE request_id=p_request;
      IF FOUND THEN
        IF replay.request_hash<>v_hash THEN RETURN jsonb_build_object('error','idempotency_conflict'); END IF;
        RETURN jsonb_build_object('result',replay.result_code,'generation',replay.result_generation,'runId',replay.run_id,
          'replayed',true,'commandRequestId',CASE WHEN replay.result_code='accepted' AND replay.run_id IS NOT NULL THEN replay.request_id ELSE NULL END);
      END IF;
      SELECT * INTO c FROM %1$I.agent_runtime_controls WHERE agent_id=p_agent FOR UPDATE;
      IF p_expected<>coalesce(c.generation,0) THEN RETURN jsonb_build_object('error','runtime_generation_conflict'); END IF;
      IF c.agent_id IS NULL OR c.desired_state='stopped' THEN
        v_result := jsonb_build_object('result','noop','generation',coalesce(c.generation,0),'runId',c.active_run_id,'replayed',false,'commandRequestId',NULL);
        INSERT INTO %1$I.agent_runtime_control_requests(request_id,organization_id,agent_id,action,request_hash,
          expected_generation,result_generation,result_code,run_id,actor_user_id,reason)
          VALUES(p_request,a.organization_id,p_agent,'stop',v_hash,p_expected,coalesce(c.generation,0),'noop',c.active_run_id,p_actor,v_reason);
        RETURN v_result;
      END IF;
      IF c.active_run_id IS NULL THEN RETURN jsonb_build_object('error','runtime_control_corrupt'); END IF;
      SELECT * INTO r FROM %1$I.agent_engine_runs WHERE id=c.active_run_id AND agent_id=p_agent FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','runtime_control_corrupt'); END IF;
      v_generation := c.generation+1;
      UPDATE %1$I.agent_runtime_controls SET desired_state='stopped',generation=v_generation,last_request_id=p_request,
        changed_by=p_actor,change_reason=v_reason,updated_at=clock_timestamp() WHERE agent_id=p_agent;
      DELETE FROM %1$I.runtime_routes WHERE agent_id=p_agent;
      UPDATE %1$I.agent_engine_runs SET status='stopping',desired_state='stopped',stop_reason=v_reason,
        stop_requested_at=clock_timestamp(),last_command_request_id=p_request,updated_at=clock_timestamp() WHERE id=r.id;
      INSERT INTO %1$I.control_outbox(organization_id,aggregate_type,aggregate_id,event_type,payload,request_id)
        VALUES(a.organization_id,'runtime',p_agent,'runtime.stop.requested',jsonb_build_object(
          'agentId',p_agent,'runId',r.id,'runGeneration',r.run_generation,'fenceGeneration',v_generation,'reason',v_reason),p_request);
      INSERT INTO %1$I.agent_runtime_control_requests(request_id,organization_id,agent_id,action,request_hash,
        expected_generation,result_generation,result_code,run_id,actor_user_id,reason)
        VALUES(p_request,a.organization_id,p_agent,'stop',v_hash,p_expected,v_generation,'accepted',r.id,p_actor,v_reason);
      RETURN jsonb_build_object('result','accepted','generation',v_generation,'runId',r.id,'replayed',false,'commandRequestId',p_request);
    END
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_control_claim(p_worker text,p_limit integer)
    RETURNS SETOF %1$I.control_outbox
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    BEGIN
      IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 100 OR p_worker ~ '[[:cntrl:]]'
        OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
      THEN RAISE EXCEPTION 'runtime_claim_invalid' USING ERRCODE='22023'; END IF;
      RETURN QUERY
        WITH candidates AS (
          SELECT id FROM %1$I.control_outbox
          WHERE event_type IN ('runtime.start.requested','runtime.stop.requested') AND available_at<=clock_timestamp()
            AND (status='queued' OR (status='leased' AND lease_until<clock_timestamp()))
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT p_limit
        )
        UPDATE %1$I.control_outbox o SET status='leased',leased_by=p_worker,
          lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1,updated_at=clock_timestamp()
        FROM candidates c WHERE o.id=c.id RETURNING o.*;
    END
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_control_complete(p_worker text,p_command uuid,p_status text,p_error text,p_attempt integer)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE q record; c record; r record; v_request uuid; v_fence bigint;
    BEGIN
      IF p_worker IS NULL OR p_command IS NULL OR p_status IS NULL OR p_status NOT IN ('succeeded','failed','dead')
        OR (p_error IS NOT NULL AND (length(p_error)>100 OR p_error !~ '^[a-zA-Z0-9_.:-]+$'))
      THEN RAISE EXCEPTION 'runtime_completion_invalid' USING ERRCODE='22023'; END IF;
      SELECT * INTO q FROM %1$I.control_outbox WHERE id=p_command;
      IF NOT FOUND THEN RETURN false; END IF;
      -- Keep the same agent -> control -> run -> outbox lock order as receipts and user intent changes.
      IF p_status='dead' AND q.event_type='runtime.start.requested' THEN
        PERFORM 1 FROM %1$I.agents WHERE id=q.aggregate_id FOR UPDATE;
        SELECT * INTO c FROM %1$I.agent_runtime_controls WHERE agent_id=q.aggregate_id FOR UPDATE;
        SELECT * INTO r FROM %1$I.agent_engine_runs WHERE id=q.payload->>'runId' AND agent_id=q.aggregate_id FOR UPDATE;
      END IF;
      SELECT * INTO q FROM %1$I.control_outbox WHERE id=p_command FOR UPDATE;
      IF q.status IS DISTINCT FROM 'leased' OR q.leased_by IS DISTINCT FROM p_worker
        OR q.attempts IS DISTINCT FROM p_attempt OR q.lease_until IS NULL OR q.lease_until<=clock_timestamp() THEN RETURN false; END IF;
      IF p_status='dead' AND q.event_type='runtime.start.requested' THEN
        IF c.desired_state='running' AND c.active_run_id=r.id THEN
          v_request:=gen_random_uuid(); v_fence:=c.generation+1;
          UPDATE %1$I.agent_runtime_controls SET desired_state='stopped',generation=v_fence,last_request_id=v_request,
            changed_by=NULL,change_reason='start_attempts_exhausted',updated_at=clock_timestamp() WHERE agent_id=c.agent_id;
          DELETE FROM %1$I.runtime_routes WHERE agent_id=c.agent_id;
          UPDATE %1$I.agent_engine_runs SET status='stopping',desired_state='stopped',stop_reason='start_attempts_exhausted',
            stop_requested_at=clock_timestamp(),last_command_request_id=v_request,updated_at=clock_timestamp() WHERE id=r.id;
          INSERT INTO %1$I.control_outbox(organization_id,aggregate_type,aggregate_id,event_type,payload,request_id)
            VALUES(c.organization_id,'runtime',c.agent_id,'runtime.stop.requested',jsonb_build_object(
              'agentId',c.agent_id,'runId',r.id,'runGeneration',r.run_generation,'fenceGeneration',v_fence,'reason','start_attempts_exhausted'),v_request);
          INSERT INTO %1$I.agent_runtime_control_requests(request_id,organization_id,agent_id,action,request_hash,
            expected_generation,result_generation,result_code,run_id,actor_user_id,reason)
            VALUES(v_request,c.organization_id,c.agent_id,'recovery_stop',md5(q.request_id::text),c.generation,v_fence,'accepted',r.id,NULL,'start_attempts_exhausted');
        END IF;
      END IF;
      UPDATE %1$I.control_outbox SET
        status=CASE WHEN p_status='failed' THEN 'queued' ELSE p_status END,
        available_at=CASE WHEN p_status='failed' THEN clock_timestamp()+make_interval(secs=>least(30.0,0.25*power(2,least(attempts,7)))) ELSE available_at END,
        leased_by=NULL,lease_until=NULL,last_error=p_error,updated_at=clock_timestamp()
      WHERE id=p_command AND status='leased' AND leased_by=p_worker AND attempts=p_attempt AND lease_until>clock_timestamp()
        AND event_type IN ('runtime.start.requested','runtime.stop.requested');
      RETURN FOUND;
    END
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_control_commit_started(
      p_worker text,p_request uuid,p_agent text,p_run text,p_run_generation bigint,p_ref text,p_url text,p_attempt integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE c record; r record; v_status text; v_request uuid; v_fence bigint; v_governance jsonb;
    BEGIN
      IF p_worker IS NULL OR p_request IS NULL OR p_agent IS NULL OR p_run IS NULL OR p_run_generation IS NULL OR p_run_generation<=0
        OR p_ref IS NULL OR length(p_ref) NOT BETWEEN 1 AND 500 OR p_ref ~ '[[:cntrl:]]'
        OR p_url IS NULL OR length(p_url) NOT BETWEEN 1 AND 2048 OR p_url ~ '[[:cntrl:]]' OR p_url !~ '^https?://[^[:space:]]+$'
      THEN RAISE EXCEPTION 'runtime_commit_invalid' USING ERRCODE='22023'; END IF;
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      PERFORM 1 FROM %1$I.agents WHERE id=p_agent FOR UPDATE;
      SELECT * INTO c FROM %1$I.agent_runtime_controls WHERE agent_id=p_agent FOR UPDATE;
      SELECT * INTO r FROM %1$I.agent_engine_runs WHERE id=p_run AND agent_id=p_agent FOR UPDATE;
      IF c.agent_id IS NULL OR r.id IS NULL OR r.run_generation<>p_run_generation
        THEN RETURN jsonb_build_object('error','runtime_run_not_found'); END IF;
      IF NOT %1$I.runtime_control_receipt(p_worker,p_request,p_attempt,'runtime.start.requested',p_agent,p_run,p_run_generation,NULL)
        THEN RETURN jsonb_build_object('error','runtime_command_lease_lost'); END IF;
      v_governance := %1$I.platform_account_access(c.owner_user_id);
      IF v_governance IS NULL THEN RAISE EXCEPTION 'governance_unavailable'; END IF;
      v_status := v_governance->>'status';
      IF v_status='active' AND c.governance_version=(v_governance->>'version')::integer AND c.desired_state='running' AND c.generation=p_run_generation AND c.active_run_id=p_run THEN
        IF r.status='running' AND (r.container_ref IS DISTINCT FROM p_ref OR r.runtime_url IS DISTINCT FROM p_url)
          THEN RETURN jsonb_build_object('error','orchestrator_identity_conflict'); END IF;
        UPDATE %1$I.agent_engine_runs SET status='running',desired_state='running',container_ref=p_ref,runtime_url=p_url,
          started_at=coalesce(started_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=p_run;
        INSERT INTO %1$I.runtime_routes(agent_id,organization_id,runtime_url,route_version,health_status,last_seen_at)
          VALUES(p_agent,c.organization_id,p_url,p_run_generation,'healthy',clock_timestamp())
          ON CONFLICT(agent_id) DO UPDATE SET organization_id=EXCLUDED.organization_id,runtime_url=EXCLUDED.runtime_url,
            route_version=EXCLUDED.route_version,health_status='healthy',last_seen_at=EXCLUDED.last_seen_at,updated_at=clock_timestamp();
        UPDATE %1$I.agents SET status='ready',updated_at=clock_timestamp() WHERE id=p_agent;
        RETURN jsonb_build_object('result','committed','generation',c.generation,'runId',p_run);
      END IF;

      IF (v_status IS DISTINCT FROM 'active' OR c.governance_version<>(v_governance->>'version')::integer)
        AND c.desired_state='running' AND c.generation=p_run_generation AND c.active_run_id=p_run THEN
        v_request := gen_random_uuid(); v_fence := c.generation+1;
        UPDATE %1$I.agent_runtime_controls SET desired_state='stopped',generation=v_fence,last_request_id=v_request,
          changed_by=NULL,change_reason='account_'||coalesce(v_status,'unavailable'),updated_at=clock_timestamp() WHERE agent_id=p_agent;
        INSERT INTO %1$I.agent_runtime_control_requests(request_id,organization_id,agent_id,action,request_hash,
          expected_generation,result_generation,result_code,run_id,actor_user_id,reason)
          VALUES(v_request,c.organization_id,p_agent,'governance_stop',md5(p_agent||':'||c.generation::text||':'||coalesce(v_status,'unavailable')),
            c.generation,v_fence,'accepted',p_run,NULL,'account_'||coalesce(v_status,'unavailable'));
        c.generation:=v_fence; c.desired_state:='stopped';
      END IF;
      UPDATE %1$I.agent_engine_runs SET status='stopping',desired_state='stopped',container_ref=p_ref,runtime_url=p_url,
        stop_reason=coalesce(stop_reason,'stale_start'),stop_requested_at=coalesce(stop_requested_at,clock_timestamp()),
        updated_at=clock_timestamp() WHERE id=p_run AND status<>'stopped';
      DELETE FROM %1$I.runtime_routes WHERE agent_id=p_agent AND route_version=p_run_generation;
      IF NOT EXISTS(SELECT 1 FROM %1$I.control_outbox WHERE event_type='runtime.stop.requested' AND payload->>'runId'=p_run) THEN
        v_request:=gen_random_uuid(); v_fence:=greatest(c.generation,p_run_generation+1);
        INSERT INTO %1$I.control_outbox(organization_id,aggregate_type,aggregate_id,event_type,payload,request_id)
          VALUES(c.organization_id,'runtime',p_agent,'runtime.stop.requested',jsonb_build_object(
            'agentId',p_agent,'runId',p_run,'runGeneration',p_run_generation,'fenceGeneration',v_fence,'reason','stale_start'),v_request);
      END IF;
      RETURN jsonb_build_object('result','stale_stop_enqueued','generation',c.generation,'runId',p_run);
    END
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_control_commit_stopped(
      p_worker text,p_request uuid,p_agent text,p_run text,p_run_generation bigint,p_fence bigint,p_status text,p_confirmed timestamptz,p_attempt integer
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE c record; r record; v_active boolean;
    BEGIN
      IF p_worker IS NULL OR p_request IS NULL OR p_agent IS NULL OR p_run IS NULL OR p_run_generation IS NULL OR p_run_generation<=0
        OR p_fence IS NULL OR p_fence<=p_run_generation OR p_status IS NULL OR p_status NOT IN ('stopped','absent') OR p_confirmed IS NULL
      THEN RAISE EXCEPTION 'runtime_commit_invalid' USING ERRCODE='22023'; END IF;
      PERFORM 1 FROM %1$I.agents WHERE id=p_agent FOR UPDATE;
      SELECT * INTO c FROM %1$I.agent_runtime_controls WHERE agent_id=p_agent FOR UPDATE;
      SELECT * INTO r FROM %1$I.agent_engine_runs WHERE id=p_run AND agent_id=p_agent FOR UPDATE;
      IF r.id IS NULL OR r.run_generation<>p_run_generation THEN RETURN jsonb_build_object('error','runtime_run_not_found'); END IF;
      IF NOT %1$I.runtime_control_receipt(p_worker,p_request,p_attempt,'runtime.stop.requested',p_agent,p_run,p_run_generation,p_fence)
        THEN RETURN jsonb_build_object('error','runtime_command_lease_lost'); END IF;
      UPDATE %1$I.agent_engine_runs SET status='stopped',desired_state='stopped',stop_confirmed_at=p_confirmed,
        stopped_at=p_confirmed,updated_at=clock_timestamp() WHERE id=p_run;
      DELETE FROM %1$I.runtime_routes WHERE agent_id=p_agent AND route_version=p_run_generation;
      v_active := c.active_run_id=p_run;
      IF v_active THEN
        UPDATE %1$I.agent_runtime_controls SET active_run_id=NULL,updated_at=clock_timestamp() WHERE agent_id=p_agent;
        IF c.desired_state='stopped' THEN UPDATE %1$I.agents SET status='stopped',updated_at=clock_timestamp() WHERE id=p_agent; END IF;
      END IF;
      RETURN jsonb_build_object('result','committed','generation',coalesce(c.generation,p_fence),'runId',p_run);
    END
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_control_reconcile_governance(p_worker text,p_limit integer)
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE candidate record; item record; r record; v_request uuid; v_generation bigint; v_stopped integer:=0; v_hex text;
    BEGIN
      IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 100 OR p_worker ~ '[[:cntrl:]]'
        OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
      THEN RAISE EXCEPTION 'runtime_reconcile_invalid' USING ERRCODE='22023'; END IF;
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      FOR candidate IN
        SELECT c.agent_id
        FROM %1$I.agent_runtime_controls c
        LEFT JOIN %1$I.platform_account_governance g ON g.user_id=c.owner_user_id
        WHERE c.desired_state='running' AND (coalesce(g.status,'active')<>'active' OR c.governance_version<>coalesce(g.version,0))
        ORDER BY c.owner_user_id,c.agent_id LIMIT p_limit
      LOOP
        -- Audit foreign keys also lock agents: acquire that lock BEFORE control, never implicitly after it.
        PERFORM 1 FROM %1$I.agents WHERE id=candidate.agent_id FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN CONTINUE; END IF;
        SELECT c.*,coalesce(g.status,'active') account_status,coalesce(g.version,0) account_version INTO item
          FROM %1$I.agent_runtime_controls c
          LEFT JOIN %1$I.platform_account_governance g ON g.user_id=c.owner_user_id
          WHERE c.agent_id=candidate.agent_id AND c.desired_state='running'
            AND (coalesce(g.status,'active')<>'active' OR c.governance_version<>coalesce(g.version,0))
          FOR UPDATE OF c SKIP LOCKED;
        IF NOT FOUND THEN CONTINUE; END IF;
        v_hex:=md5(item.owner_user_id||':'||item.account_version::text||':'||item.agent_id);
        -- State under the control lock provides idempotency; callers must not reserve a predictable system UUID.
        v_request:=gen_random_uuid();
        v_generation:=item.generation+1;
        SELECT * INTO r FROM %1$I.agent_engine_runs WHERE id=item.active_run_id AND agent_id=item.agent_id FOR UPDATE;
        UPDATE %1$I.agent_runtime_controls SET desired_state='stopped',generation=v_generation,last_request_id=v_request,
          changed_by=NULL,change_reason='account_'||item.account_status,updated_at=clock_timestamp() WHERE agent_id=item.agent_id;
        DELETE FROM %1$I.runtime_routes WHERE agent_id=item.agent_id;
        IF r.id IS NOT NULL THEN
          UPDATE %1$I.agent_engine_runs SET status='stopping',desired_state='stopped',stop_reason='account_'||item.account_status,
            stop_requested_at=clock_timestamp(),last_command_request_id=v_request,updated_at=clock_timestamp() WHERE id=r.id;
          INSERT INTO %1$I.control_outbox(organization_id,aggregate_type,aggregate_id,event_type,payload,request_id)
            VALUES(item.organization_id,'runtime',item.agent_id,'runtime.stop.requested',jsonb_build_object(
              'agentId',item.agent_id,'runId',r.id,'runGeneration',r.run_generation,'fenceGeneration',v_generation,
              'reason','account_'||item.account_status),v_request);
        END IF;
        INSERT INTO %1$I.agent_runtime_control_requests(request_id,organization_id,agent_id,action,request_hash,
          expected_generation,result_generation,result_code,run_id,actor_user_id,reason)
          VALUES(v_request,item.organization_id,item.agent_id,'governance_stop',v_hex,item.generation,v_generation,'accepted',r.id,NULL,
            'account_'||item.account_status);
        v_stopped:=v_stopped+1;
      END LOOP;
      RETURN jsonb_build_object('stopped',v_stopped,'started',0);
    END
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_control_governance_notify() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    BEGIN
      IF NEW.status IN ('suspended','banned') AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
        PERFORM pg_notify('bairui_runtime_governance',NEW.user_id);
      END IF;
      RETURN NEW;
    END
    $body$
  $definition$,s);
END
$migration$;

DROP TRIGGER IF EXISTS platform_account_governance_runtime_notify ON platform_account_governance;
CREATE TRIGGER platform_account_governance_runtime_notify
  AFTER INSERT OR UPDATE OF status ON platform_account_governance
  FOR EACH ROW EXECUTE FUNCTION runtime_control_governance_notify();

REVOKE ALL ON FUNCTION runtime_control_request_start(text,text,uuid,bigint,integer,bigint,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_control_request_stop(text,text,uuid,bigint,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_control_claim(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_control_receipt(text,uuid,integer,text,text,text,bigint,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_control_prepare(text,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_control_complete(text,uuid,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_control_commit_started(text,uuid,text,text,bigint,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_control_commit_stopped(text,uuid,text,text,bigint,bigint,text,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_control_reconcile_governance(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_control_governance_notify() FROM PUBLIC;

COMMIT;
