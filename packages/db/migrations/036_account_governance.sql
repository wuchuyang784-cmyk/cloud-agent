-- D1 账号治理。DBA 在备份后执行；不依赖模拟调度 033，不改变 Agent 生命周期。
BEGIN;
CREATE TABLE IF NOT EXISTS platform_account_governance (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('active','suspended','banned')),
  version integer NOT NULL CHECK (version > 0),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_governance_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  target_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  previous_status text NOT NULL CHECK (previous_status IN ('active','suspended','banned')),
  status text NOT NULL CHECK (status IN ('active','suspended','banned')),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 2 AND 500),
  request_id uuid NOT NULL,
  result jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, request_id)
);
CREATE INDEX IF NOT EXISTS platform_governance_audit_target_idx ON platform_governance_audit(target_user_id, id DESC);
ALTER TABLE platform_account_governance ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_account_governance FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_governance_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_governance_audit FORCE ROW LEVEL SECURITY;

DO $migration$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_account_access(p_user text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
      SELECT jsonb_build_object('status',coalesce(g.status,'active'), 'version',coalesce(g.version,0),'changedAt',g.changed_at)
      FROM %1$I.users u LEFT JOIN %1$I.platform_account_governance g ON g.user_id=u.id WHERE u.id=p_user
    $body$
  $definition$, s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_account_session_allowed(p_auth text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
      SELECT NOT EXISTS(SELECT 1 FROM %1$I.users u JOIN %1$I.platform_account_governance g ON g.user_id=u.id
        WHERE u.auth_subject='better-auth:' || p_auth AND g.status='banned')
    $body$
  $definition$, s);

  -- 会话插入和封禁共用身份锁；在取得锁后重新取快照，防止封禁时并发登录漏删会话。
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_account_session_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:governance:session:' || NEW."userId", 0));
      IF NOT %1$I.platform_account_session_allowed(NEW."userId") THEN
        RAISE EXCEPTION 'account_banned' USING ERRCODE='P0001';
      END IF;
      RETURN NEW;
    END $body$
  $definition$, s);
  EXECUTE format('DROP TRIGGER IF EXISTS account_governance_session_guard ON %I.ba_session', s);
  EXECUTE format('CREATE TRIGGER account_governance_session_guard BEFORE INSERT OR UPDATE ON %I.ba_session FOR EACH ROW EXECUTE FUNCTION %I.platform_account_session_guard()', s, s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_governance_accounts(p_actor text, p_ids text[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM %1$I.platform_role_bindings r WHERE r.user_id=p_actor AND r.revoked_at IS NULL)
        OR %1$I.platform_account_access(p_actor)->>'status' IS DISTINCT FROM 'active' THEN RETURN NULL; END IF;
      IF p_ids IS NULL OR cardinality(p_ids)>100 THEN RAISE EXCEPTION 'invalid_query' USING ERRCODE='22023'; END IF;
      RETURN (SELECT coalesce(jsonb_object_agg(u.id, %1$I.platform_account_access(u.id)), '{}'::jsonb) FROM %1$I.users u WHERE u.id=ANY(p_ids));
    END $body$
  $definition$, s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_governance_read(p_actor text, p_target text, p_after bigint DEFAULT NULL) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
    DECLARE rows jsonb; account jsonb;
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM %1$I.platform_role_bindings r WHERE r.user_id=p_actor AND r.revoked_at IS NULL)
        OR %1$I.platform_account_access(p_actor)->>'status' IS DISTINCT FROM 'active' THEN RETURN jsonb_build_object('error','platform_role_required'); END IF;
      account := %1$I.platform_account_access(p_target);
      IF account IS NULL THEN RETURN jsonb_build_object('error','not_found'); END IF;
      SELECT coalesce(jsonb_agg(item ORDER BY id DESC),'[]'::jsonb) INTO rows FROM (
        SELECT a.id, jsonb_build_object('id',a.id::text,'actorUserId',a.actor_user_id,'targetUserId',a.target_user_id,
          'previousStatus',a.previous_status,'status',a.status,'reason',a.reason,'requestId',a.request_id,'occurredAt',a.occurred_at) item
        FROM %1$I.platform_governance_audit a WHERE a.target_user_id=p_target AND (p_after IS NULL OR a.id<p_after)
        ORDER BY a.id DESC LIMIT 26
      ) items;
      RETURN jsonb_build_object('account',account,'items',CASE WHEN jsonb_array_length(rows)>25 THEN rows-25 ELSE rows END,
        'nextCursor',CASE WHEN jsonb_array_length(rows)>25 THEN rows->24->>'id' ELSE NULL END);
    END $body$
  $definition$, s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_governance_change(p_actor text, p_target text, p_status text, p_version integer, p_reason text, p_request uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
    DECLARE prior jsonb; account jsonb; auth_id text; replay %1$I.platform_governance_audit%%ROWTYPE;
    BEGIN
      IF p_status IS NULL OR p_status NOT IN ('active','suspended','banned') OR p_version IS NULL OR p_version<0
        OR p_reason IS NULL OR length(btrim(p_reason))<2 OR length(p_reason)>500 OR p_reason ~ '[[:cntrl:]]'
        OR p_request IS NULL THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
      -- 只串行低频管理变更，不锁普通业务请求。状态与管理员互封判断使用锁后的快照。
      PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:governance:changes',0));
      IF NOT EXISTS(SELECT 1 FROM %1$I.platform_role_bindings r WHERE r.user_id=p_actor AND r.role='platform_admin' AND r.revoked_at IS NULL)
        OR %1$I.platform_account_access(p_actor)->>'status' IS DISTINCT FROM 'active' THEN RETURN jsonb_build_object('error','platform_role_required'); END IF;
      prior := %1$I.platform_account_access(p_target);
      IF prior IS NULL THEN RETURN jsonb_build_object('error','not_found'); END IF;
      IF p_actor=p_target THEN RETURN jsonb_build_object('error','self_governance_forbidden'); END IF;
      SELECT * INTO replay FROM %1$I.platform_governance_audit WHERE actor_user_id=p_actor AND request_id=p_request;
      IF FOUND THEN
        IF replay.target_user_id=p_target AND replay.status=p_status AND replay.expected_version=p_version AND replay.reason=p_reason THEN
          RETURN jsonb_build_object('account',replay.result,'requestId',p_request,'replayed',true);
        END IF;
        RETURN jsonb_build_object('error','idempotency_conflict');
      END IF;
      IF (prior->>'version')::integer <> p_version THEN RETURN jsonb_build_object('error','version_conflict'); END IF;
      IF prior->>'status'=p_status THEN RETURN jsonb_build_object('error','state_unchanged'); END IF;
      IF p_status<>'active' AND EXISTS(SELECT 1 FROM %1$I.platform_role_bindings WHERE user_id=p_target AND role='platform_admin' AND revoked_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM %1$I.platform_role_bindings r WHERE r.user_id<>p_target AND r.role='platform_admin' AND r.revoked_at IS NULL AND %1$I.platform_account_access(r.user_id)->>'status'='active')
        THEN RETURN jsonb_build_object('error','last_admin_protected'); END IF;
      SELECT substring(auth_subject FROM 13) INTO auth_id FROM %1$I.users WHERE id=p_target AND starts_with(auth_subject,'better-auth:');
      IF auth_id IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:governance:session:' || auth_id,0)); END IF;
      INSERT INTO %1$I.platform_account_governance(user_id,status,version) VALUES(p_target,p_status,p_version+1)
        ON CONFLICT(user_id) DO UPDATE SET status=EXCLUDED.status,version=EXCLUDED.version,changed_at=clock_timestamp();
      IF p_status='banned' AND auth_id IS NOT NULL THEN DELETE FROM %1$I.ba_session WHERE "userId"=auth_id; END IF;
      account := %1$I.platform_account_access(p_target);
      INSERT INTO %1$I.platform_governance_audit(actor_user_id,target_user_id,previous_status,status,expected_version,reason,request_id,result)
        VALUES(p_actor,p_target,prior->>'status',p_status,p_version,p_reason,p_request,account);
      RETURN jsonb_build_object('account',account,'requestId',p_request,'replayed',false);
    END $body$
  $definition$, s);

  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_account_access(text) FROM PUBLIC', s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_account_session_allowed(text) FROM PUBLIC', s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_account_session_guard() FROM PUBLIC', s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_governance_accounts(text,text[]) FROM PUBLIC', s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_governance_read(text,text,bigint) FROM PUBLIC', s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_governance_change(text,text,text,integer,text,uuid) FROM PUBLIC', s);
END $migration$;
COMMIT;
