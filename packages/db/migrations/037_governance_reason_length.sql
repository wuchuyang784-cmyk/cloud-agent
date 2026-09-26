-- 账号治理原因允许单字符。依赖 036；DBA 备份后执行，保留历史、状态和既有函数授权。
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE platform_governance_audit
  DROP CONSTRAINT platform_governance_audit_reason_check,
  ADD CONSTRAINT platform_governance_audit_reason_check CHECK (length(reason) BETWEEN 1 AND 500);

DO $migration$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_governance_change(p_actor text, p_target text, p_status text, p_version integer, p_reason text, p_request uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
    DECLARE prior jsonb; account jsonb; auth_id text; replay %1$I.platform_governance_audit%%ROWTYPE;
    BEGIN
      IF p_status IS NULL OR p_status NOT IN ('active','suspended','banned') OR p_version IS NULL OR p_version<0
        OR p_reason IS NULL OR length(btrim(p_reason))<1 OR length(p_reason)>500 OR p_reason ~ '[[:cntrl:]]'
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
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_governance_change(text,text,text,integer,text,uuid) FROM PUBLIC', s);
END $migration$;
COMMIT;
