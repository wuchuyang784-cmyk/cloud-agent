-- 公告 B：显式 expiryDays:30 重置草稿到期策略，保持编辑/版本/幂等/审计同一事务。
-- 从 041 对应定义完整替换，保留函数签名、OID、所有权与显式授权；不修改历史迁移。
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $migration$
DECLARE s text:=current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_validate(p jsonb, user_query boolean DEFAULT false, is_query boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $body$
    DECLARE allowed text[]; key text; ts timestamptz; command text;
    BEGIN
      IF p IS NULL OR jsonb_typeof(p)<>'object' THEN RAISE EXCEPTION 'invalid_announcement_input' USING ERRCODE='22023'; END IF;
      IF is_query THEN
        allowed := CASE WHEN user_query THEN ARRAY['id','after','limit','history'] ELSE ARRAY['id','after','limit','status','audit'] END;
        IF p ? 'limit' THEN
          IF jsonb_typeof(p->'limit')<>'number' OR (p->>'limit') !~ '^[0-9]{1,3}$' THEN RAISE EXCEPTION 'invalid_announcement_query' USING ERRCODE='22023'; END IF;
          IF (p->>'limit')::integer NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_announcement_query' USING ERRCODE='22023'; END IF;
        END IF;
        IF (p ? 'id' AND (jsonb_typeof(p->'id')<>'string' OR (p->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
          OR (p ? 'audit' AND jsonb_typeof(p->'audit')<>'boolean') OR (p ? 'history' AND jsonb_typeof(p->'history')<>'boolean')
          OR (p->>'audit'='true' AND NOT p ? 'id')
          OR (p ? 'status' AND (jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR (p->>'status') NOT IN ('draft','scheduled','published','withdrawn','expired')))
          THEN RAISE EXCEPTION 'invalid_announcement_query' USING ERRCODE='22023'; END IF;
        IF p ? 'after' THEN
          IF jsonb_typeof(p->'after')<>'string' OR (CASE WHEN p->>'audit'='true' THEN (p->>'after') !~ '^[1-9][0-9]{0,17}$'
            ELSE (p->>'after') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' END)
            THEN RAISE EXCEPTION 'invalid_announcement_query' USING ERRCODE='22023'; END IF;
        END IF;
      ELSE
        command := p->>'action';
        IF command IS NULL OR command NOT IN ('create','edit','publish','schedule','cancel','withdraw')
          OR jsonb_typeof(p->'requestId') IS DISTINCT FROM 'string'
          OR (p->>'requestId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN RAISE EXCEPTION 'invalid_announcement_input' USING ERRCODE='22023'; END IF;
        allowed := ARRAY['action','requestId'];
        IF command<>'create' THEN
          allowed := allowed || ARRAY['id','expectedVersion'];
          IF jsonb_typeof(p->'id') IS DISTINCT FROM 'string'
            OR (p->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            OR jsonb_typeof(p->'expectedVersion') IS DISTINCT FROM 'number' OR (p->>'expectedVersion') !~ '^[1-9][0-9]{0,9}$'
            OR (p->>'expectedVersion')::bigint>2147483646
            THEN RAISE EXCEPTION 'invalid_announcement_input' USING ERRCODE='22023'; END IF;
        END IF;
        IF command IN ('create','edit') THEN
          allowed := allowed || ARRAY['title','body','severity','pinned','expiresAt','expiryDays'];
          IF jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR length(p->>'title') NOT BETWEEN 1 AND 120
            OR length(btrim(p->>'title'))=0 OR (p->>'title') ~ '[[:cntrl:]]'
            OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string' OR length(p->>'body') NOT BETWEEN 1 AND 20000
            OR length(btrim(p->>'body',E' \t\n\r'))=0 OR (replace(replace(p->>'body',E'\n',''),E'\t','')) ~ '[[:cntrl:]]'
            OR (p ? 'severity' AND (jsonb_typeof(p->'severity')<>'string' OR (p->>'severity') NOT IN ('normal','important')))
            OR (p ? 'pinned' AND jsonb_typeof(p->'pinned')<>'boolean')
            OR (p ? 'expiryDays' AND (p->'expiryDays' IS DISTINCT FROM '30'::jsonb OR p ? 'expiresAt'))
            THEN RAISE EXCEPTION 'invalid_announcement_input' USING ERRCODE='22023'; END IF;
        END IF;
        IF command='schedule' THEN
          allowed := allowed || ARRAY['scheduledAt'];
          IF jsonb_typeof(p->'scheduledAt') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'invalid_announcement_input' USING ERRCODE='22023'; END IF;
        END IF;
        IF command='withdraw' THEN
          allowed := allowed || ARRAY['reason'];
          IF jsonb_typeof(p->'reason') IS DISTINCT FROM 'string' OR length(btrim(p->>'reason')) NOT BETWEEN 1 AND 500 OR length(p->>'reason')>500
            OR (p->>'reason') ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'invalid_announcement_input' USING ERRCODE='22023'; END IF;
        END IF;
        FOREACH key IN ARRAY ARRAY['expiresAt','scheduledAt'] LOOP
          IF p ? key AND p->key<>'null'::jsonb THEN
            IF jsonb_typeof(p->key)<>'string' OR (p->>key) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?(Z|[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00))$'
              THEN RAISE EXCEPTION 'invalid_announcement_input' USING ERRCODE='22023'; END IF;
            BEGIN
              ts := (p->>key)::timestamptz;
              IF extract(year FROM ts AT TIME ZONE 'UTC') NOT BETWEEN 1 AND 9999 THEN RAISE EXCEPTION 'invalid_announcement_input' USING ERRCODE='22023'; END IF;
            EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'invalid_announcement_input' USING ERRCODE='22023'; END;
          END IF;
        END LOOP;
      END IF;
      IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT k=ANY(allowed)) THEN RAISE EXCEPTION 'invalid_announcement_input' USING ERRCODE='22023'; END IF;
    END $body$
  $definition$,s);
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_change(p_actor text,p jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE a %1$I.platform_announcements%%ROWTYPE; prior_version integer:=0; at_time timestamptz; start_time timestamptz;
      actor_role text; governance jsonb; replay %1$I.platform_announcement_requests%%ROWTYPE; result jsonb; event_action text; fields jsonb;
    BEGIN
      PERFORM %1$I.platform_announcement_validate(p);
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      SELECT role INTO actor_role FROM %1$I.platform_role_bindings WHERE user_id=p_actor AND revoked_at IS NULL FOR SHARE;
      governance := %1$I.platform_account_access(p_actor);
      IF actor_role IS DISTINCT FROM 'platform_admin' OR governance->>'status' IS DISTINCT FROM 'active' THEN RETURN jsonb_build_object('error','platform_role_required'); END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:announcement:request:'||p_actor||':'||(p->>'requestId'),0));
      SELECT * INTO replay FROM %1$I.platform_announcement_requests WHERE actor_user_id=p_actor AND request_id=(p->>'requestId')::uuid;
      IF FOUND THEN
        IF replay.input=p THEN RETURN replay.result || jsonb_build_object('replayed',true); END IF;
        RETURN jsonb_build_object('error','idempotency_conflict');
      END IF;
      IF p->>'action'<>'create' THEN
        SELECT * INTO a FROM %1$I.platform_announcements WHERE id=(p->>'id')::uuid FOR UPDATE;
        IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;
        IF a.version<>(p->>'expectedVersion')::integer THEN RETURN jsonb_build_object('error','version_conflict'); END IF;
        prior_version:=a.version;
      END IF;
      at_time:=clock_timestamp();
      IF p->>'action'='create' THEN
        a.id:=gen_random_uuid(); a.status:='draft'; a.version:=0; a.created_by:=p_actor; a.created_at:=at_time;
        a.severity:='normal'; a.pinned:=false; a.expiry_days:=30;
      END IF;
      IF p->>'action' IN ('create','edit') THEN
        IF a.status<>'draft' THEN RETURN jsonb_build_object('error','invalid_announcement_state'); END IF;
        a.title:=btrim(p->>'title'); a.body:=btrim(p->>'body',E' \t\n\r');
        IF p ? 'severity' THEN a.severity:=p->>'severity'; END IF;
        IF p ? 'pinned' THEN a.pinned:=(p->>'pinned')::boolean; END IF;
        IF p ? 'expiresAt' THEN a.expires_at:=(p->>'expiresAt')::timestamptz; a.expiry_days:=NULL; END IF;
        IF p ? 'expiryDays' THEN a.expiry_days:=30; a.expires_at:=NULL; END IF;
        IF a.expires_at<=at_time THEN RETURN jsonb_build_object('error','invalid_announcement_time'); END IF;
        event_action:=CASE WHEN p->>'action'='create' THEN 'created' ELSE 'draft_updated' END;
      ELSIF p->>'action' IN ('publish','schedule') THEN
        IF a.status<>'draft' THEN RETURN jsonb_build_object('error','invalid_announcement_state'); END IF;
        start_time:=CASE WHEN p->>'action'='schedule' THEN (p->>'scheduledAt')::timestamptz ELSE at_time END;
        IF (p->>'action'='schedule' AND start_time<=at_time) OR a.expires_at<=start_time THEN RETURN jsonb_build_object('error','invalid_announcement_time'); END IF;
        IF a.expiry_days IS NOT NULL THEN a.expires_at:=start_time+a.expiry_days*interval '24 hours'; END IF;
        IF p->>'action'='schedule' THEN
          a.status:='scheduled'; a.scheduled_at:=start_time; a.scheduled_by:=p_actor; a.schedule_governance_version:=(governance->>'version')::integer;
          event_action:='schedule_set';
        ELSE a.status:='published'; a.published_at:=at_time; event_action:='published'; END IF;
      ELSIF p->>'action'='cancel' THEN
        IF a.status<>'scheduled' THEN RETURN jsonb_build_object('error','invalid_announcement_state'); END IF;
        a.status:='draft'; a.scheduled_at:=NULL; a.scheduled_by:=NULL; a.schedule_governance_version:=NULL;
        IF a.expiry_days IS NOT NULL THEN a.expires_at:=NULL; END IF;
        event_action:='schedule_cancelled';
      ELSE
        IF a.status<>'published' OR a.expires_at<=at_time THEN RETURN jsonb_build_object('error','invalid_announcement_state'); END IF;
        a.status:='withdrawn'; a.withdrawn_at:=at_time; a.withdrawn_by:=p_actor; a.withdrawal_reason:=btrim(p->>'reason'); event_action:='withdrawn';
      END IF;
      a.version:=a.version+1; a.updated_by:=p_actor; a.updated_at:=at_time;
      IF p->>'action'='create' THEN
        INSERT INTO %1$I.platform_announcements SELECT a.*;
      ELSE
        UPDATE %1$I.platform_announcements SET title=a.title,body=a.body,severity=a.severity,pinned=a.pinned,status=a.status,version=a.version,
          updated_by=a.updated_by,updated_at=a.updated_at,scheduled_at=a.scheduled_at,scheduled_by=a.scheduled_by,
          schedule_governance_version=a.schedule_governance_version,published_at=a.published_at,expires_at=a.expires_at,expiry_days=a.expiry_days,
          withdrawn_at=a.withdrawn_at,withdrawn_by=a.withdrawn_by,withdrawal_reason=a.withdrawal_reason WHERE id=a.id;
      END IF;
      result:=jsonb_build_object('announcement',%1$I.platform_announcement_document(a,at_time),'requestId',p->>'requestId','replayed',false);
      SELECT coalesce(jsonb_agg(k ORDER BY k),'[]'::jsonb) INTO fields FROM jsonb_object_keys(p) k WHERE k NOT IN ('action','id','expectedVersion','requestId');
      INSERT INTO %1$I.platform_announcement_requests(actor_user_id,request_id,input,announcement_id,result,occurred_at)
        VALUES(p_actor,(p->>'requestId')::uuid,p,a.id,result,at_time);
      INSERT INTO %1$I.platform_announcement_audit(announcement_id,actor_user_id,executor_type,action,request_id,previous_version,version,content_hash,changed_fields,scheduled_at,published_at,reason,occurred_at)
        VALUES(a.id,p_actor,'admin',event_action,(p->>'requestId')::uuid,prior_version,a.version,
          encode(sha256(convert_to(a.title||E'\n'||a.body,'UTF8')),'hex'),fields,a.scheduled_at,a.published_at,a.withdrawal_reason,at_time);
      RETURN result;
    END $body$
  $definition$,s);
  EXECUTE format('REVOKE ALL ON FUNCTION %1$I.platform_announcement_validate(jsonb,boolean,boolean),%1$I.platform_announcement_change(text,jsonb) FROM PUBLIC',s);
END $migration$;
COMMIT;
