-- E3：受限 Controller 观察租约、运行状态回流与聚合诊断。依赖 039，不依赖 033/038。
BEGIN;
ALTER TABLE agent_runtime_controls
  ADD COLUMN IF NOT EXISTS observation_next_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS observation_token uuid,
  ADD COLUMN IF NOT EXISTS observation_worker text,
  ADD COLUMN IF NOT EXISTS observation_until timestamptz,
  ADD COLUMN IF NOT EXISTS observation_run_id text,
  ADD COLUMN IF NOT EXISTS observation_run_generation bigint,
  ADD COLUMN IF NOT EXISTS observation_control_generation bigint,
  ADD COLUMN IF NOT EXISTS observed_run_id text,
  ADD COLUMN IF NOT EXISTS observed_status text,
  ADD COLUMN IF NOT EXISTS observation_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS observation_success_at timestamptz;
CREATE INDEX IF NOT EXISTS agent_runtime_controls_observation_due_idx
  ON agent_runtime_controls(observation_next_at,agent_id) WHERE active_run_id IS NOT NULL;

DO $migration$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_supervision_claim(p_worker text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE c record; v_token uuid; v_now timestamptz := clock_timestamp();
    BEGIN
      IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 100 OR p_worker ~ '[[:cntrl:]]'
        THEN RAISE EXCEPTION 'observation_worker_invalid' USING ERRCODE='22023'; END IF;
      SELECT controls.*,r.run_generation INTO c FROM %1$I.agent_runtime_controls controls
        JOIN %1$I.agent_engine_runs r ON r.id=controls.active_run_id AND r.agent_id=controls.agent_id
        WHERE (controls.observation_until IS NULL OR controls.observation_until<=v_now
          OR controls.observation_run_id IS DISTINCT FROM controls.active_run_id
          OR controls.observation_control_generation IS DISTINCT FROM controls.generation)
        AND (controls.observation_next_at<=v_now OR controls.observed_run_id IS DISTINCT FROM controls.active_run_id
          OR controls.observation_control_generation IS DISTINCT FROM controls.generation)
        ORDER BY controls.observation_next_at,controls.agent_id FOR UPDATE OF controls SKIP LOCKED LIMIT 1;
      IF NOT FOUND THEN RETURN NULL; END IF;
      v_token:=gen_random_uuid();
      UPDATE %1$I.agent_runtime_controls SET observation_token=v_token,observation_worker=p_worker,
        observation_until=v_now+interval '60s',observation_run_id=c.active_run_id,
        observation_run_generation=c.run_generation,observation_control_generation=c.generation
        WHERE agent_id=c.agent_id;
      RETURN jsonb_build_object('workerId',p_worker,'leaseToken',v_token,'agentId',c.agent_id,'runId',c.active_run_id,
        'runGeneration',c.run_generation,'controlGeneration',c.generation,'until',v_now+interval '60s');
    END
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_supervision_record(
      p_worker text,p_token uuid,p_agent text,p_run text,p_run_generation bigint,p_control_generation bigint,
      p_status text,p_observed timestamptz,p_ref text,p_url text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE c record; r record; v_governance jsonb; v_request uuid; v_generation bigint; v_now timestamptz;
    BEGIN
      IF p_worker IS NULL OR length(p_worker) NOT BETWEEN 1 AND 100 OR p_worker ~ '[[:cntrl:]]'
        OR p_token IS NULL OR p_agent IS NULL OR p_run IS NULL OR p_run_generation IS NULL OR p_run_generation<=0
        OR p_control_generation IS NULL OR p_control_generation<=0
        OR p_status IS NULL OR p_status NOT IN ('starting','running','stopping','stopped','absent','error')
        OR p_observed IS NULL OR NOT isfinite(p_observed)
        OR (p_status='running' AND (p_ref IS NULL OR length(p_ref) NOT BETWEEN 1 AND 500 OR p_ref ~ '[[:cntrl:]]'
          OR p_url IS NULL OR length(p_url) NOT BETWEEN 1 AND 2048 OR p_url ~ '[[:cntrl:]]' OR p_url !~ '^https?://[^[:space:]]+$'))
        THEN RAISE EXCEPTION 'observation_invalid' USING ERRCODE='22023'; END IF;
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      PERFORM 1 FROM %1$I.agents WHERE id=p_agent FOR UPDATE;
      SELECT * INTO c FROM %1$I.agent_runtime_controls WHERE agent_id=p_agent FOR UPDATE;
      SELECT * INTO r FROM %1$I.agent_engine_runs WHERE id=p_run AND agent_id=p_agent FOR UPDATE;
      v_now:=clock_timestamp();
      IF c.agent_id IS NULL OR c.observation_token IS DISTINCT FROM p_token OR c.observation_worker IS DISTINCT FROM p_worker
        OR c.observation_until IS NULL OR c.observation_until<=v_now
        THEN RETURN jsonb_build_object('error','observation_lease_lost'); END IF;
      IF r.id IS NULL OR c.active_run_id IS DISTINCT FROM p_run OR c.generation<>p_control_generation
        OR r.run_generation<>p_run_generation OR c.observation_run_id IS DISTINCT FROM p_run
        OR c.observation_run_generation IS DISTINCT FROM p_run_generation
        OR c.observation_control_generation IS DISTINCT FROM p_control_generation
        THEN RETURN jsonb_build_object('error','observation_superseded'); END IF;
      IF p_status='running' AND r.status='running' AND (r.container_ref IS DISTINCT FROM p_ref OR r.runtime_url IS DISTINCT FROM p_url)
        THEN RETURN jsonb_build_object('error','observation_identity_conflict'); END IF;
      -- Governance is read before mutation; unavailable state rolls the complete transaction back.
      v_governance:=%1$I.platform_account_access(c.owner_user_id);
      IF v_governance IS NULL OR v_governance->>'status' NOT IN ('active','suspended','banned')
        OR v_governance->>'version' IS NULL THEN RAISE EXCEPTION 'governance_unavailable'; END IF;
      UPDATE %1$I.agent_runtime_controls SET observed_run_id=p_run,observed_status=p_status,
        observation_checked_at=v_now,observation_next_at=v_now+interval '10s',observation_token=NULL,
        observation_worker=NULL,observation_until=NULL,
        observation_success_at=CASE WHEN p_status<>'error' THEN v_now WHEN observed_run_id=p_run THEN observation_success_at ELSE NULL END
        WHERE agent_id=p_agent;
      IF p_status IN ('stopped','absent') THEN
        v_request:=gen_random_uuid(); v_generation:=c.generation+CASE WHEN c.desired_state='running' THEN 1 ELSE 0 END;
        UPDATE %1$I.agent_runtime_controls SET desired_state='stopped',generation=v_generation,active_run_id=NULL,
          last_request_id=v_request,changed_by=NULL,change_reason='observed_terminal',updated_at=v_now WHERE agent_id=p_agent;
        UPDATE %1$I.agent_engine_runs SET desired_state='stopped',status='stopped',stop_reason=coalesce(stop_reason,'observed_terminal'),
          stop_confirmed_at=v_now,stopped_at=v_now,updated_at=v_now WHERE id=p_run;
        DELETE FROM %1$I.runtime_routes WHERE agent_id=p_agent AND route_version=p_run_generation;
        UPDATE %1$I.agents SET status='stopped',updated_at=v_now WHERE id=p_agent;
        INSERT INTO %1$I.agent_runtime_control_requests(request_id,organization_id,agent_id,action,request_hash,
          expected_generation,result_generation,result_code,run_id,actor_user_id,reason)
          VALUES(v_request,c.organization_id,p_agent,'recovery_stop',md5(p_run||':'||p_status),c.generation,v_generation,
            'accepted',p_run,NULL,'observed_terminal');
        RETURN jsonb_build_object('result','stopped');
      END IF;
      IF p_status='running' AND r.status='running' AND c.desired_state='running'
        AND v_governance->>'status'='active' AND c.governance_version=(v_governance->>'version')::integer THEN
        -- Only an existing identical route may get a fresh heartbeat; observation never publishes a route.
        UPDATE %1$I.runtime_routes SET health_status='healthy',last_seen_at=v_now,updated_at=v_now
          WHERE agent_id=p_agent AND route_version=p_run_generation AND runtime_url=p_url;
      END IF;
      RETURN jsonb_build_object('result','observed');
    END
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.runtime_supervision_snapshot() RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
      SELECT jsonb_build_object('active',count(*),'stopping',count(*) FILTER(WHERE r.status='stopping'),
        'stopOverdue',count(*) FILTER(WHERE r.status='stopping' AND r.stop_requested_at<clock_timestamp()-interval '60s'),
        'deadPending',count(*) FILTER(WHERE EXISTS(SELECT 1 FROM %1$I.control_outbox q WHERE q.status='dead'
          AND q.event_type IN ('runtime.start.requested','runtime.stop.requested') AND q.payload->>'runId'=r.id)),
        'observationErrors',count(*) FILTER(WHERE c.observed_run_id=r.id AND (c.observed_status='error'
          OR (r.status='running' AND c.observed_status<>'running'))),
        'observationStale',count(*) FILTER(WHERE coalesce(CASE WHEN c.observed_run_id=r.id THEN c.observation_success_at END,r.created_at)
          <clock_timestamp()-interval '60s'))
      FROM %1$I.agent_runtime_controls c JOIN %1$I.agent_engine_runs r ON r.id=c.active_run_id AND r.agent_id=c.agent_id
    $body$
  $definition$,s);
END
$migration$;
REVOKE ALL ON FUNCTION runtime_supervision_claim(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_supervision_record(text,uuid,text,text,bigint,bigint,text,timestamptz,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION runtime_supervision_snapshot() FROM PUBLIC;
COMMIT;
