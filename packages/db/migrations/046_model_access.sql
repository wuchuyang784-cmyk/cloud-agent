-- F2 private credential vault and bounded machine admission. Explicit deployment only.
-- Requires 032/036/037/039. No browser grants, runtime startup or model execution.
BEGIN;

CREATE TEMP TABLE model_access_existing_functions ON COMMIT DROP AS
  SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname=current_schema() AND p.proname IN (
    'model_envelope_valid','model_metadata','model_actor','model_runtime_valid',
    'model_credential_list','model_credential_get','model_credential_create','model_credential_rotate','model_credential_revoke',
    'model_grant_issue','model_grant_revoke','model_request_reserve','model_request_finish');

CREATE TABLE IF NOT EXISTS model_credentials (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  provider text NOT NULL CHECK(provider ~ '^[a-z][a-z0-9-]{0,47}$'),
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80 AND label=btrim(label) AND label !~ '[[:cntrl:]]'),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  envelope jsonb NOT NULL CHECK(octet_length(envelope::text)<=12000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(organization_id,user_id) REFERENCES organization_members(organization_id,user_id) ON DELETE RESTRICT,
  UNIQUE(organization_id,user_id,id)
);
CREATE INDEX IF NOT EXISTS model_credentials_owner_idx ON model_credentials(organization_id,user_id,status,updated_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS model_runtime_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  user_id text NOT NULL,
  credential_id uuid NOT NULL,
  credential_version integer NOT NULL CHECK(credential_version>0),
  agent_id text NOT NULL,
  run_id text NOT NULL,
  run_generation bigint NOT NULL CHECK(run_generation BETWEEN 1 AND 9007199254740991),
  governance_version integer NOT NULL CHECK(governance_version>=0),
  model text NOT NULL CHECK(model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  max_requests integer NOT NULL CHECK(max_requests BETWEEN 1 AND 32),
  used_requests integer NOT NULL DEFAULT 0 CHECK(used_requests BETWEEN 0 AND max_requests),
  revoked_at timestamptz,
  FOREIGN KEY(organization_id,user_id) REFERENCES organization_members(organization_id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,user_id,credential_id) REFERENCES model_credentials(organization_id,user_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(agent_id,run_id) REFERENCES agent_engine_runs(agent_id,id) ON DELETE RESTRICT,
  CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '300 seconds')
);
CREATE TABLE IF NOT EXISTS model_gateway_requests (
  request_id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  grant_id uuid NOT NULL REFERENCES model_runtime_grants(id) ON DELETE RESTRICT,
  run_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('active','completed','failed','unknown')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz NOT NULL,
  finished_at timestamptz,
  input_tokens bigint CHECK(input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens bigint CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
  FOREIGN KEY(organization_id,user_id) REFERENCES organization_members(organization_id,user_id) ON DELETE RESTRICT,
  CHECK((input_tokens IS NULL)=(output_tokens IS NULL)),
  CHECK(state='completed' OR input_tokens IS NULL),
  CHECK((state='active')=(finished_at IS NULL)),
  CHECK(lease_until=started_at+interval '125 seconds')
);
CREATE UNIQUE INDEX IF NOT EXISTS model_gateway_requests_active_run_idx ON model_gateway_requests(run_id) WHERE state='active';
CREATE TABLE IF NOT EXISTS model_access_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  user_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('credential_created','credential_rotated','credential_revoked','grant_issued','grant_revoked','request_reserved','request_completed','request_failed','request_unknown')),
  credential_id uuid,
  grant_id uuid,
  agent_id text,
  run_id text,
  request_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(organization_id,user_id) REFERENCES organization_members(organization_id,user_id) ON DELETE RESTRICT
  -- Deliberately no FK to mutable credential/grant/request rows: finishing a call
  -- must not invert admission/governance lock order or wait for a parent update.
);

ALTER TABLE model_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE model_runtime_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_runtime_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE model_gateway_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_gateway_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE model_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_access_audit FORCE ROW LEVEL SECURITY;

DO $migration$
DECLARE s text := current_schema(); item record; grantee_name text;
BEGIN
  -- Default ACLs can grant TRUNCATE (which bypasses RLS). Strip all direct
  -- non-owner table privileges, including inherited default privileges.
  FOR item IN SELECT c.oid,c.relname,c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=s AND c.relname IN ('model_credentials','model_runtime_grants','model_gateway_requests','model_access_audit')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC',s,item.relname);
    FOR grantee_name IN SELECT DISTINCT r.rolname FROM aclexplode((SELECT relacl FROM pg_class WHERE oid=item.oid)) a
      JOIN pg_roles r ON r.oid=a.grantee WHERE a.grantee<>item.relowner
    LOOP EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I',s,item.relname,grantee_name); END LOOP;
  END LOOP;

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_envelope_valid(p jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE k text; d bytea; v text; minimum integer; maximum integer;
    BEGIN
      IF p IS NULL OR jsonb_typeof(p)<>'object' OR octet_length(p::text)>12000
        OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p) key) IS DISTINCT FROM ARRAY['ciphertext','iv','keyId','tag','version','wrappedKey']
        OR p->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p->'keyId')<>'string'
        OR p->>'keyId' !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$' THEN RETURN false; END IF;
      FOREACH k IN ARRAY ARRAY['wrappedKey','iv','ciphertext','tag'] LOOP
        v:=p->>k;
        minimum:=CASE k WHEN 'wrappedKey' THEN 384 WHEN 'iv' THEN 12 ELSE 16 END;
        maximum:=CASE k WHEN 'wrappedKey' THEN 1024 WHEN 'iv' THEN 12 WHEN 'ciphertext' THEN 4096 ELSE 16 END;
        IF jsonb_typeof(p->k)<>'string' OR v !~ '^[A-Za-z0-9_-]+$' OR length(v)>ceil(maximum*4.0/3) THEN RETURN false; END IF;
        d:=decode(translate(v,'-_','+/')||repeat('=',(4-length(v)%%4)%%4),'base64');
        IF octet_length(d) NOT BETWEEN minimum AND maximum
          OR rtrim(translate(replace(encode(d,'base64'),chr(10),''),'+/','-_'),'=')<>v THEN RETURN false; END IF;
      END LOOP;
      RETURN true;
    EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN RETURN false;
    END $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_metadata(p %1$I.model_credentials) RETURNS jsonb
    LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
      SELECT jsonb_build_object('id',p.id,'provider',p.provider,'label',p.label,'version',p.version,'status',p.status,'createdAt',p.created_at,'updatedAt',p.updated_at)
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_actor(p_org text,p_user text,p_write boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE g jsonb;
    BEGIN
      IF p_org IS NULL OR p_user IS NULL OR length(p_org) NOT BETWEEN 1 AND 128 OR length(p_user) NOT BETWEEN 1 AND 128
        OR p_org ~ '[[:space:][:cntrl:]]' OR p_user ~ '[[:space:][:cntrl:]]' OR p_write IS NULL
        THEN RAISE EXCEPTION 'invalid_model_input' USING ERRCODE='22023'; END IF;
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      IF p_write THEN PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:model:owner:'||jsonb_build_array(p_org,p_user)::text,0)); END IF;
      PERFORM 1 FROM %1$I.organization_members m JOIN %1$I.users u ON u.id=m.user_id
        WHERE m.organization_id=p_org AND m.user_id=p_user FOR SHARE OF m,u;
      IF NOT FOUND THEN RAISE EXCEPTION 'model_access_denied' USING ERRCODE='42501'; END IF;
      g:=%1$I.platform_account_access(p_user);
      IF g IS NULL OR g->>'status' NOT IN ('active','suspended','banned') OR g->>'version' IS NULL THEN
        RAISE EXCEPTION 'model_access_unavailable'; END IF;
      IF g->>'status'='banned' OR (p_write AND g->>'status'<>'active') THEN
        RAISE EXCEPTION 'model_access_denied' USING ERRCODE='42501'; END IF;
      RETURN g;
    END $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_runtime_valid(p_org text,p_user text,p_agent text,p_run text,p_generation bigint,p_governance integer,p_admission boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE a record; c record; r record;
    BEGIN
      -- Match E1 order: Agent -> control -> run, with a new snapshot after each lock.
      SELECT * INTO a FROM %1$I.agents WHERE id=p_agent FOR SHARE;
      IF NOT FOUND OR a.organization_id<>p_org OR a.owner_user_id<>p_user OR a.engine<>'pi' THEN RETURN false; END IF;
      SELECT * INTO c FROM %1$I.agent_runtime_controls WHERE agent_id=p_agent FOR SHARE;
      IF NOT FOUND OR c.organization_id<>p_org OR c.owner_user_id<>p_user OR c.desired_state<>'running'
        OR c.active_run_id IS DISTINCT FROM p_run OR c.generation<>p_generation OR c.governance_version<>p_governance THEN RETURN false; END IF;
      SELECT * INTO r FROM %1$I.agent_engine_runs WHERE id=p_run AND agent_id=p_agent FOR SHARE;
      RETURN FOUND AND r.organization_id=p_org AND r.engine='pi' AND r.run_generation=p_generation AND r.desired_state='running'
        AND (r.status='running' OR (NOT p_admission AND r.status='initializing'));
    END $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_credential_list(p_org text,p_user text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    BEGIN
      PERFORM %1$I.model_actor(p_org,p_user,false);
      RETURN (SELECT coalesce(jsonb_agg(item ORDER BY active DESC,updated_at DESC,id DESC),'[]'::jsonb) FROM
        (SELECT %1$I.model_metadata(c) item,(status='active') active,updated_at,id FROM %1$I.model_credentials c
          WHERE organization_id=p_org AND user_id=p_user ORDER BY (status='active') DESC,updated_at DESC,id DESC LIMIT 50) rows);
    END $body$
  $definition$,s);
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_credential_get(p_org text,p_user text,p_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE c %1$I.model_credentials;
    BEGIN
      PERFORM %1$I.model_actor(p_org,p_user,false);
      SELECT * INTO c FROM %1$I.model_credentials WHERE id=p_id AND organization_id=p_org AND user_id=p_user;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','model_credential_not_found'); END IF;
      RETURN %1$I.model_metadata(c);
    END $body$
  $definition$,s);
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_credential_create(p_org text,p_user text,p_input jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE c %1$I.model_credentials;
    BEGIN
      PERFORM %1$I.model_actor(p_org,p_user,true);
      IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p_input) key) IS DISTINCT FROM ARRAY['envelope','id','label','provider']
        OR jsonb_typeof(p_input->'id')<>'string' OR p_input->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(p_input->'provider')<>'string' OR p_input->>'provider' !~ '^[a-z][a-z0-9-]{0,47}$'
        OR jsonb_typeof(p_input->'label')<>'string' OR length(p_input->>'label') NOT BETWEEN 1 AND 80
        OR p_input->>'label'<>btrim(p_input->>'label') OR p_input->>'label' ~ '[[:cntrl:]]' OR NOT %1$I.model_envelope_valid(p_input->'envelope')
        THEN RAISE EXCEPTION 'invalid_model_input' USING ERRCODE='22023'; END IF;
      IF (SELECT count(*) FROM %1$I.model_credentials WHERE organization_id=p_org AND user_id=p_user AND status='active')>=20 THEN RETURN jsonb_build_object('error','model_access_conflict'); END IF;
      INSERT INTO %1$I.model_credentials(id,organization_id,user_id,provider,label,envelope)
        VALUES((p_input->>'id')::uuid,p_org,p_user,p_input->>'provider',p_input->>'label',p_input->'envelope') ON CONFLICT DO NOTHING RETURNING * INTO c;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','model_access_conflict'); END IF;
      INSERT INTO %1$I.model_access_audit(organization_id,user_id,action,credential_id) VALUES(p_org,p_user,'credential_created',c.id);
      RETURN %1$I.model_metadata(c);
    END $body$
  $definition$,s);
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_credential_rotate(p_org text,p_user text,p_id uuid,p_version integer,p_envelope jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE c %1$I.model_credentials;
    BEGIN
      PERFORM %1$I.model_actor(p_org,p_user,true);
      IF p_version IS NULL OR p_version NOT BETWEEN 1 AND 2147483646 OR NOT %1$I.model_envelope_valid(p_envelope) THEN RAISE EXCEPTION 'invalid_model_input' USING ERRCODE='22023'; END IF;
      SELECT * INTO c FROM %1$I.model_credentials WHERE id=p_id AND organization_id=p_org AND user_id=p_user FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','model_credential_not_found'); END IF;
      IF c.status<>'active' OR c.version<>p_version THEN RETURN jsonb_build_object('error','model_access_conflict'); END IF;
      UPDATE %1$I.model_credentials SET version=version+1,envelope=p_envelope,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO c;
      INSERT INTO %1$I.model_access_audit(organization_id,user_id,action,credential_id) VALUES(p_org,p_user,'credential_rotated',p_id);
      RETURN %1$I.model_metadata(c);
    END $body$
  $definition$,s);
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_credential_revoke(p_org text,p_user text,p_id uuid,p_version integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE c %1$I.model_credentials;
    BEGIN
      PERFORM %1$I.model_actor(p_org,p_user,true);
      IF p_version IS NULL OR p_version NOT BETWEEN 1 AND 2147483646 THEN RAISE EXCEPTION 'invalid_model_input' USING ERRCODE='22023'; END IF;
      SELECT * INTO c FROM %1$I.model_credentials WHERE id=p_id AND organization_id=p_org AND user_id=p_user FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','model_credential_not_found'); END IF;
      IF c.status<>'active' OR c.version<>p_version THEN RETURN jsonb_build_object('error','model_access_conflict'); END IF;
      UPDATE %1$I.model_credentials SET status='revoked',version=version+1,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO c;
      INSERT INTO %1$I.model_access_audit(organization_id,user_id,action,credential_id) VALUES(p_org,p_user,'credential_revoked',p_id);
      RETURN %1$I.model_metadata(c);
    END $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_grant_issue(p_org text,p_user text,p jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE g jsonb; c %1$I.model_credentials; q %1$I.model_runtime_grants; t timestamptz;
    BEGIN
      IF p IS NULL OR jsonb_typeof(p)<>'object' OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(p) key)
        IS DISTINCT FROM ARRAY['agentId','credentialId','maxRequests','model','runGeneration','runId','tokenHash','ttlSeconds']
        OR jsonb_typeof(p->'credentialId')<>'string' OR p->>'credentialId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(p->'agentId')<>'string' OR length(p->>'agentId') NOT BETWEEN 1 AND 128 OR p->>'agentId' ~ '[[:space:][:cntrl:]]'
        OR jsonb_typeof(p->'runId')<>'string' OR p->>'runId' !~ '^(run-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(p->'model')<>'string' OR p->>'model' !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
        OR jsonb_typeof(p->'tokenHash')<>'string' OR p->>'tokenHash' !~ '^[a-f0-9]{64}$'
        OR jsonb_typeof(p->'runGeneration')<>'number' OR p->>'runGeneration' !~ '^[1-9][0-9]{0,15}$'
        OR jsonb_typeof(p->'ttlSeconds')<>'number' OR p->>'ttlSeconds' !~ '^[1-9][0-9]{0,2}$'
        OR jsonb_typeof(p->'maxRequests')<>'number' OR p->>'maxRequests' !~ '^[1-9][0-9]?$'
        THEN RAISE EXCEPTION 'invalid_model_input' USING ERRCODE='22023'; END IF;
      IF (p->>'runGeneration')::bigint>9007199254740991 OR (p->>'ttlSeconds')::integer>300 OR (p->>'maxRequests')::integer>32
        THEN RAISE EXCEPTION 'invalid_model_input' USING ERRCODE='22023'; END IF;
      BEGIN g:=%1$I.model_actor(p_org,p_user,true);
        EXCEPTION WHEN insufficient_privilege THEN RETURN jsonb_build_object('error','model_grant_invalid'); END;
      SELECT * INTO c FROM %1$I.model_credentials WHERE id=(p->>'credentialId')::uuid AND organization_id=p_org AND user_id=p_user FOR SHARE;
      IF NOT FOUND OR c.status<>'active' THEN RETURN jsonb_build_object('error','model_grant_invalid'); END IF;
      IF NOT coalesce(%1$I.model_runtime_valid(p_org,p_user,p->>'agentId',p->>'runId',(p->>'runGeneration')::bigint,(g->>'version')::integer,false),false)
        THEN RETURN jsonb_build_object('error','model_grant_invalid'); END IF;
      t:=clock_timestamp();
      INSERT INTO %1$I.model_runtime_grants(organization_id,user_id,credential_id,credential_version,agent_id,run_id,run_generation,governance_version,model,token_hash,issued_at,expires_at,max_requests)
        VALUES(p_org,p_user,c.id,c.version,p->>'agentId',p->>'runId',(p->>'runGeneration')::bigint,(g->>'version')::integer,p->>'model',p->>'tokenHash',t,t+(p->>'ttlSeconds')::integer*interval '1 second',(p->>'maxRequests')::integer)
        ON CONFLICT DO NOTHING RETURNING * INTO q;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','model_grant_invalid'); END IF;
      INSERT INTO %1$I.model_access_audit(organization_id,user_id,action,grant_id,agent_id,run_id) VALUES(p_org,p_user,'grant_issued',q.id,q.agent_id,q.run_id);
      RETURN jsonb_build_object('grantId',q.id,'expiresAt',q.expires_at,'maxRequests',q.max_requests);
    END $body$
  $definition$,s);
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_grant_revoke(p_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE g %1$I.model_runtime_grants;
    BEGIN
      SELECT * INTO g FROM %1$I.model_runtime_grants WHERE id=p_id;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','model_grant_invalid'); END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:model:owner:'||jsonb_build_array(g.organization_id,g.user_id)::text,0));
      UPDATE %1$I.model_runtime_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=p_id RETURNING * INTO g;
      INSERT INTO %1$I.model_access_audit(organization_id,user_id,action,grant_id) VALUES(g.organization_id,g.user_id,'grant_revoked',p_id);
      RETURN jsonb_build_object('revoked',true);
    END $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_request_reserve(p_hash text,p_id uuid,p_model text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE q %1$I.model_runtime_grants; c %1$I.model_credentials; g jsonb; t timestamptz; expired record;
    BEGIN
      IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_id IS NULL OR p_model IS NULL OR p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
        THEN RETURN jsonb_build_object('error','model_grant_invalid'); END IF;
      SELECT * INTO q FROM %1$I.model_runtime_grants WHERE token_hash=p_hash;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','model_grant_invalid'); END IF;
      BEGIN g:=%1$I.model_actor(q.organization_id,q.user_id,true);
        EXCEPTION WHEN insufficient_privilege THEN RETURN jsonb_build_object('error','model_grant_invalid'); END;
      SELECT * INTO q FROM %1$I.model_runtime_grants WHERE token_hash=p_hash FOR UPDATE;
      t:=clock_timestamp();
      IF q.revoked_at IS NOT NULL OR q.issued_at>t OR q.expires_at<=t OR q.model<>p_model OR q.used_requests>=q.max_requests OR q.governance_version<>(g->>'version')::integer
        THEN RETURN jsonb_build_object('error','model_grant_invalid'); END IF;
      SELECT * INTO c FROM %1$I.model_credentials WHERE id=q.credential_id AND organization_id=q.organization_id AND user_id=q.user_id FOR SHARE;
      IF NOT FOUND OR c.status<>'active' OR c.version<>q.credential_version THEN RETURN jsonb_build_object('error','model_grant_invalid'); END IF;
      IF NOT coalesce(%1$I.model_runtime_valid(q.organization_id,q.user_id,q.agent_id,q.run_id,q.run_generation,q.governance_version,true),false)
        THEN RETURN jsonb_build_object('error','model_grant_invalid'); END IF;
      -- Fresh time after all locks. Never admit with a grant that expired waiting.
      t:=clock_timestamp();
      IF q.issued_at>t OR q.expires_at<=t THEN RETURN jsonb_build_object('error','model_grant_invalid'); END IF;
      FOR expired IN UPDATE %1$I.model_gateway_requests SET state='unknown',finished_at=t WHERE run_id=q.run_id AND state='active' AND lease_until<=t RETURNING request_id
      LOOP
        INSERT INTO %1$I.model_access_audit(organization_id,user_id,action,request_id) VALUES(q.organization_id,q.user_id,'request_unknown',expired.request_id);
      END LOOP;
      IF EXISTS(SELECT 1 FROM %1$I.model_gateway_requests WHERE run_id=q.run_id AND state='active') THEN RETURN jsonb_build_object('error','model_gateway_busy'); END IF;
      INSERT INTO %1$I.model_gateway_requests(request_id,organization_id,user_id,grant_id,run_id,state,started_at,lease_until)
        VALUES(p_id,q.organization_id,q.user_id,q.id,q.run_id,'active',t,t+interval '125 seconds') ON CONFLICT DO NOTHING;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','model_access_conflict'); END IF;
      UPDATE %1$I.model_runtime_grants SET used_requests=used_requests+1 WHERE id=q.id;
      INSERT INTO %1$I.model_access_audit(organization_id,user_id,action,grant_id,request_id) VALUES(q.organization_id,q.user_id,'request_reserved',q.id,p_id);
      RETURN jsonb_build_object('requestId',p_id,'provider',c.provider,'model',q.model,
        'context',jsonb_build_object('organizationId',q.organization_id,'userId',q.user_id,'credentialId',c.id,'provider',c.provider,'version',c.version),'envelope',c.envelope);
    END $body$
  $definition$,s);
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.model_request_finish(p_id uuid,p_state text,p_input bigint,p_output bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE r %1$I.model_gateway_requests; t timestamptz;
    BEGIN
      IF p_id IS NULL OR p_state IS NULL OR p_state NOT IN ('completed','failed','unknown') OR (p_input IS NULL)<>(p_output IS NULL)
        OR p_input NOT BETWEEN 0 AND 9007199254740991 OR p_output NOT BETWEEN 0 AND 9007199254740991
        OR (p_state<>'completed' AND p_input IS NOT NULL) THEN RAISE EXCEPTION 'invalid_model_input' USING ERRCODE='22023'; END IF;
      -- No account/runtime/grant locks: a call admitted before stop can finish.
      SELECT * INTO r FROM %1$I.model_gateway_requests WHERE request_id=p_id FOR UPDATE;
      IF NOT FOUND OR r.state<>'active' THEN RETURN jsonb_build_object('error','model_access_conflict'); END IF;
      t:=clock_timestamp();
      IF r.lease_until<=t THEN
        UPDATE %1$I.model_gateway_requests SET state='unknown',finished_at=t WHERE request_id=p_id;
        INSERT INTO %1$I.model_access_audit(organization_id,user_id,action,request_id) VALUES(r.organization_id,r.user_id,'request_unknown',p_id);
        RETURN jsonb_build_object('error','model_access_conflict');
      END IF;
      UPDATE %1$I.model_gateway_requests SET state=p_state,input_tokens=p_input,output_tokens=p_output,finished_at=t WHERE request_id=p_id;
      INSERT INTO %1$I.model_access_audit(organization_id,user_id,action,request_id) VALUES(r.organization_id,r.user_id,'request_'||p_state,p_id);
      RETURN jsonb_build_object('state',p_state);
    END $body$
  $definition$,s);

  -- CREATE OR REPLACE preserves deliberate function grants on rerun. New
  -- functions may inherit EXECUTE via default ACLs; remove those once only.
  FOR item IN SELECT p.oid,p.proname,p.proowner,pg_get_function_identity_arguments(p.oid) args,p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=s AND p.proname IN (
      'model_envelope_valid','model_metadata','model_actor','model_runtime_valid',
      'model_credential_list','model_credential_get','model_credential_create','model_credential_rotate','model_credential_revoke',
      'model_grant_issue','model_grant_revoke','model_request_reserve','model_request_finish')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC',s,item.proname,item.args);
    IF NOT EXISTS(SELECT 1 FROM pg_temp.model_access_existing_functions e WHERE e.oid=item.oid) THEN
      FOR grantee_name IN SELECT DISTINCT r.rolname FROM aclexplode(item.proacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE a.grantee<>item.proowner
      LOOP EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM %I',s,item.proname,item.args,grantee_name); END LOOP;
    END IF;
  END LOOP;
END $migration$;
COMMIT;
