-- 公告 D：独立受限机器发布器；仅由 DBA 在备份后追加，不授予应用发布器权限。
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
ALTER TABLE platform_announcements ADD COLUMN IF NOT EXISTS publish_blocked boolean NOT NULL DEFAULT false;
ALTER TABLE platform_announcements ADD COLUMN IF NOT EXISTS last_publish_error text CHECK (last_publish_error IN ('publisher_authorization_changed','publisher_item_failed'));
ALTER TABLE platform_announcements ADD COLUMN IF NOT EXISTS publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts BETWEEN 0 AND 30);
ALTER TABLE platform_announcements ADD COLUMN IF NOT EXISTS next_publish_attempt_at timestamptz;
-- NULL on pre-D schedules deliberately requires an administrator to cancel and reconfirm.
ALTER TABLE platform_announcements ADD COLUMN IF NOT EXISTS schedule_role_revision bigint;
ALTER TABLE platform_announcement_audit ADD COLUMN IF NOT EXISTS executor_id text;
ALTER TABLE platform_announcement_audit ADD COLUMN IF NOT EXISTS schedule_governance_version integer;
CREATE INDEX IF NOT EXISTS platform_announcements_publisher_due_idx ON platform_announcements(coalesce(next_publish_attempt_at,scheduled_at),id) WHERE status='scheduled' AND NOT publish_blocked;
CREATE INDEX IF NOT EXISTS platform_announcements_publisher_expiry_idx ON platform_announcements(expires_at,id) WHERE status IN ('scheduled','published') AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_admin_audit_announcement_role_idx ON platform_admin_audit(target_user_id,id) WHERE action='role_changed';

DO $migration$
DECLARE s text:=current_schema(); existing_functions oid[]; g record;
BEGIN
  SELECT coalesce(array_agg(p.oid),'{}'::oid[]) INTO existing_functions FROM pg_proc p
    WHERE p.pronamespace=s::regnamespace AND p.proname IN ('platform_announcement_publisher_tick','platform_announcement_publisher_status');
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_document(a %1$I.platform_announcements,at_time timestamptz) RETURNS jsonb
    LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $body$
      SELECT jsonb_build_object('id',a.id,'title',a.title,'body',a.body,'severity',a.severity,'pinned',a.pinned,
        'status',CASE WHEN a.status='published' AND a.expires_at<=at_time THEN 'expired' ELSE a.status END,
        'version',a.version,'createdBy',a.created_by,'updatedBy',a.updated_by,'createdAt',a.created_at,'updatedAt',a.updated_at,
        'scheduledAt',a.scheduled_at,'scheduledBy',a.scheduled_by,'scheduleGovernanceVersion',a.schedule_governance_version,'scheduleRoleRevision',a.schedule_role_revision,
        'publishedAt',a.published_at,'expiresAt',a.expires_at,'expiryDays',a.expiry_days,
        'withdrawnAt',a.withdrawn_at,'withdrawnBy',a.withdrawn_by,'withdrawalReason',a.withdrawal_reason,
        'publishBlocked',a.publish_blocked,'lastPublishError',a.last_publish_error,'publishAttempts',a.publish_attempts,'nextPublishAttemptAt',a.next_publish_attempt_at)
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_publisher_status() RETURNS jsonb
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
      SELECT jsonb_build_object('processed',0,'published',0,'expired',0,'blocked',0,'failed',0,
        'pending',count(*) FILTER (WHERE status='scheduled' AND NOT publish_blocked AND scheduled_at<=clock_timestamp()),
        'maxDelaySeconds',coalesce(max(greatest(0,floor(extract(epoch FROM clock_timestamp()-scheduled_at)))) FILTER (WHERE status='scheduled' AND NOT publish_blocked AND scheduled_at<=clock_timestamp()),0),
        'blockedTotal',count(*) FILTER (WHERE status='scheduled' AND publish_blocked))
      FROM %1$I.platform_announcements WHERE status='scheduled'
    $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_publisher_tick(p_limit integer DEFAULT 50) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE candidate record; a %1$I.platform_announcements%%ROWTYPE; actor_role text; governance jsonb;
      at_time timestamptz; event_action text; previous_version integer; processed integer:=0; published integer:=0; expired integer:=0; blocked integer:=0; failed integer:=0;
    BEGIN
      IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'invalid_publisher_limit' USING ERRCODE='22023'; END IF;
      -- The same global governance fence used by the real governance function comes first.
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      FOR candidate IN
        SELECT n.id,n.version,n.status,n.scheduled_by,r.role responsible_role,r.revoked_at responsible_revoked_at
        FROM %1$I.platform_announcements n
        -- Lock the responsible role before admitting the candidate to the bounded batch.
        -- A locked existing role is skipped before LIMIT, so it cannot starve later administrators.
        LEFT JOIN LATERAL (
          SELECT b.user_id,b.role,b.revoked_at FROM %1$I.platform_role_bindings b
          WHERE b.user_id=n.scheduled_by FOR SHARE OF b SKIP LOCKED
        ) r ON true
        WHERE n.status IN ('scheduled','published')
          AND (n.expires_at<=clock_timestamp() OR n.status='scheduled' AND (NOT n.publish_blocked OR n.last_publish_error='publisher_item_failed') AND n.scheduled_at<=clock_timestamp())
          AND (n.next_publish_attempt_at IS NULL OR n.next_publish_attempt_at<=clock_timestamp())
          AND (n.scheduled_by IS NULL OR r.user_id IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM %1$I.platform_role_bindings existing_role WHERE existing_role.user_id=n.scheduled_by))
        ORDER BY coalesce(n.scheduled_at,n.expires_at),n.id LIMIT p_limit
      LOOP
        -- The candidate already holds its responsible-role lock, if that binding exists.
        actor_role:=CASE WHEN candidate.responsible_revoked_at IS NULL THEN candidate.responsible_role ELSE NULL END;
        SELECT * INTO a FROM %1$I.platform_announcements WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
        IF NOT FOUND OR a.version<>candidate.version OR a.status<>candidate.status OR a.scheduled_by IS DISTINCT FROM candidate.scheduled_by THEN CONTINUE; END IF;
        at_time:=clock_timestamp();
        IF NOT (a.expires_at<=at_time OR a.status='scheduled' AND (NOT a.publish_blocked OR a.last_publish_error='publisher_item_failed') AND a.scheduled_at<=at_time)
          OR a.next_publish_attempt_at>at_time THEN CONTINUE; END IF;
        processed:=processed+1; previous_version:=a.version; event_action:=NULL;
        -- All effects of an individual attempt, including its audit, roll back together.
        BEGIN
          governance:=%1$I.platform_account_access(a.scheduled_by);
          IF a.expires_at<=at_time THEN event_action:='expired';
          ELSIF a.publish_blocked OR actor_role IS DISTINCT FROM 'platform_admin' OR governance->>'status' IS DISTINCT FROM 'active'
            OR (governance->>'version')::integer IS DISTINCT FROM a.schedule_governance_version
            OR a.schedule_role_revision IS DISTINCT FROM (SELECT count(*) FROM %1$I.platform_admin_audit WHERE action='role_changed' AND target_user_id=a.scheduled_by)
            THEN event_action:='publish_blocked';
          ELSE event_action:='published'; END IF;
          UPDATE %1$I.platform_announcements SET
            status=CASE WHEN event_action='publish_blocked' THEN status ELSE event_action END,
            published_at=CASE WHEN event_action='published' THEN at_time ELSE published_at END,
            version=version+1,updated_at=at_time,
            publish_blocked=CASE WHEN event_action='publish_blocked' THEN true ELSE publish_blocked END,
            last_publish_error=CASE WHEN event_action='publish_blocked' THEN 'publisher_authorization_changed' ELSE NULL END,
            publish_attempts=least(30,publish_attempts+1),next_publish_attempt_at=NULL
          WHERE id=a.id RETURNING * INTO a;
          INSERT INTO %1$I.platform_announcement_audit(announcement_id,actor_user_id,executor_type,executor_id,schedule_governance_version,
            action,previous_version,version,content_hash,changed_fields,scheduled_at,published_at,reason,occurred_at)
          VALUES(a.id,a.scheduled_by,'system',session_user,a.schedule_governance_version,event_action,previous_version,a.version,
            encode(sha256(convert_to(a.title||E'\n'||a.body,'UTF8')),'hex'),
            CASE WHEN event_action='publish_blocked' THEN '["publishBlocked"]'::jsonb ELSE '["status"]'::jsonb END,
            a.scheduled_at,a.published_at,CASE WHEN event_action='publish_blocked' THEN 'publisher_authorization_changed' ELSE NULL END,at_time);
          IF event_action='published' THEN published:=published+1; ELSIF event_action='expired' THEN expired:=expired+1; ELSE blocked:=blocked+1; END IF;
        EXCEPTION WHEN OTHERS THEN
          -- Never persist SQLSTATE text, SQL, identity, body or the database exception detail.
          UPDATE %1$I.platform_announcements SET publish_attempts=least(30,publish_attempts+1),last_publish_error='publisher_item_failed',
            publish_blocked=publish_blocked OR coalesce(event_action='publish_blocked',false),
            next_publish_attempt_at=clock_timestamp()+make_interval(secs=>least(300,5*power(2,least(publish_attempts,6)))::double precision)
            WHERE id=candidate.id AND version=previous_version;
          failed:=failed+1;
        END;
      END LOOP;
      RETURN %1$I.platform_announcement_publisher_status() || jsonb_build_object('processed',processed,'published',published,'expired',expired,'blocked',blocked,'failed',failed);
    END $body$
  $definition$,s);

  -- Complete explicit replacement of 043's mutation definition: signature/OID/grants remain unchanged.
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_change(p_actor text,p jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE a %1$I.platform_announcements%%ROWTYPE; prior_version integer:=0; at_time timestamptz; start_time timestamptz;
      actor_role text; governance jsonb; replay %1$I.platform_announcement_requests%%ROWTYPE; result jsonb; event_action text; fields jsonb;
    BEGIN
      PERFORM %1$I.platform_announcement_validate(p);
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      SELECT role INTO actor_role FROM %1$I.platform_role_bindings WHERE user_id=p_actor AND revoked_at IS NULL FOR SHARE;
      governance:=%1$I.platform_account_access(p_actor);
      IF actor_role IS DISTINCT FROM 'platform_admin' OR governance->>'status' IS DISTINCT FROM 'active' THEN RETURN jsonb_build_object('error','platform_role_required'); END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:announcement:request:'||p_actor||':'||(p->>'requestId'),0));
      SELECT * INTO replay FROM %1$I.platform_announcement_requests WHERE actor_user_id=p_actor AND request_id=(p->>'requestId')::uuid;
      IF FOUND THEN
        IF replay.input=p THEN RETURN replay.result||jsonb_build_object('replayed',true); END IF;
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
        a.publish_blocked:=false; a.publish_attempts:=0;
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
        a.publish_blocked:=false; a.last_publish_error:=NULL; a.publish_attempts:=0; a.next_publish_attempt_at:=NULL;
        IF p->>'action'='schedule' THEN
          a.status:='scheduled'; a.scheduled_at:=start_time; a.scheduled_by:=p_actor; a.schedule_governance_version:=(governance->>'version')::integer;
          SELECT count(*) INTO a.schedule_role_revision FROM %1$I.platform_admin_audit WHERE action='role_changed' AND target_user_id=p_actor;
          event_action:='schedule_set';
        ELSE a.status:='published'; a.published_at:=at_time; event_action:='published'; END IF;
      ELSIF p->>'action'='cancel' THEN
        IF a.status<>'scheduled' THEN RETURN jsonb_build_object('error','invalid_announcement_state'); END IF;
        a.status:='draft'; a.scheduled_at:=NULL; a.scheduled_by:=NULL; a.schedule_governance_version:=NULL; a.schedule_role_revision:=NULL;
        a.publish_blocked:=false; a.last_publish_error:=NULL; a.publish_attempts:=0; a.next_publish_attempt_at:=NULL;
        IF a.expiry_days IS NOT NULL THEN a.expires_at:=NULL; END IF;
        event_action:='schedule_cancelled';
      ELSE
        IF a.status<>'published' OR a.expires_at<=at_time THEN RETURN jsonb_build_object('error','invalid_announcement_state'); END IF;
        a.status:='withdrawn'; a.withdrawn_at:=at_time; a.withdrawn_by:=p_actor; a.withdrawal_reason:=btrim(p->>'reason'); event_action:='withdrawn';
      END IF;
      a.version:=a.version+1; a.updated_by:=p_actor; a.updated_at:=at_time;
      IF p->>'action'='create' THEN INSERT INTO %1$I.platform_announcements SELECT a.*;
      ELSE
        UPDATE %1$I.platform_announcements SET title=a.title,body=a.body,severity=a.severity,pinned=a.pinned,status=a.status,version=a.version,
          updated_by=a.updated_by,updated_at=a.updated_at,scheduled_at=a.scheduled_at,scheduled_by=a.scheduled_by,
          schedule_governance_version=a.schedule_governance_version,schedule_role_revision=a.schedule_role_revision,published_at=a.published_at,expires_at=a.expires_at,expiry_days=a.expiry_days,
          withdrawn_at=a.withdrawn_at,withdrawn_by=a.withdrawn_by,withdrawal_reason=a.withdrawal_reason,
          publish_blocked=a.publish_blocked,last_publish_error=a.last_publish_error,publish_attempts=a.publish_attempts,next_publish_attempt_at=a.next_publish_attempt_at WHERE id=a.id;
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

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_read(p_actor text,q jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE records jsonb; n integer; at_time timestamptz:=clock_timestamp(); item jsonb;
    BEGIN
      IF q ? 'q' AND (jsonb_typeof(q->'q') IS DISTINCT FROM 'string' OR length(q->>'q')>200 OR (q->>'q') ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'invalid_announcement_query' USING ERRCODE='22023'; END IF;
      PERFORM %1$I.platform_announcement_validate(q-'q',false,true); n:=coalesce((q->>'limit')::integer,25);
      IF %1$I.platform_account_access(p_actor)->>'status' IS DISTINCT FROM 'active'
        OR NOT EXISTS(SELECT 1 FROM %1$I.platform_role_bindings WHERE user_id=p_actor AND revoked_at IS NULL AND role IN ('platform_admin','platform_operator','platform_viewer'))
        THEN RETURN jsonb_build_object('error','platform_role_required'); END IF;
      IF q ? 'id' THEN
        SELECT %1$I.platform_announcement_document(a,at_time) INTO item FROM %1$I.platform_announcements a WHERE id=(q->>'id')::uuid;
        IF item IS NULL THEN RETURN jsonb_build_object('error','not_found'); END IF;
        IF coalesce((q->>'audit')::boolean,false)=false THEN RETURN jsonb_build_object('announcement',item); END IF;
        SELECT coalesce(jsonb_agg(payload ORDER BY page_id DESC),'[]'::jsonb) INTO records FROM (
          SELECT e.id page_id,jsonb_build_object('id',e.id::text,'announcementId',e.announcement_id,'actorUserId',e.actor_user_id,'executorType',e.executor_type,
            'executorId',e.executor_id,'scheduleGovernanceVersion',e.schedule_governance_version,
            'action',e.action,'requestId',e.request_id,'previousVersion',e.previous_version,'version',e.version,'contentHash',e.content_hash,
            'changedFields',e.changed_fields,'scheduledAt',e.scheduled_at,'publishedAt',e.published_at,'reason',e.reason,'occurredAt',e.occurred_at) payload
          FROM %1$I.platform_announcement_audit e WHERE announcement_id=(q->>'id')::uuid AND (NOT q ? 'after' OR e.id<(q->>'after')::bigint)
          ORDER BY e.id DESC LIMIT n+1
        ) page;
      ELSE
        SELECT coalesce(jsonb_agg(payload ORDER BY page_id),'[]'::jsonb) INTO records FROM (
          SELECT a.id page_id,%1$I.platform_announcement_document(a,at_time) payload FROM %1$I.platform_announcements a
          WHERE (NOT q ? 'after' OR a.id>(q->>'after')::uuid)
            AND (NOT q ? 'status' OR (CASE WHEN a.status='published' AND a.expires_at<=at_time THEN 'expired' ELSE a.status END)=q->>'status')
            AND (NOT q ? 'q' OR strpos(lower(a.title),lower(q->>'q'))>0)
          ORDER BY a.id LIMIT n+1
        ) page;
      END IF;
      RETURN jsonb_build_object('items',CASE WHEN jsonb_array_length(records)>n THEN records-n ELSE records END,
        'nextCursor',CASE WHEN jsonb_array_length(records)>n THEN records->(n-1)->>'id' ELSE NULL END);
    END $body$
  $definition$,s);

  EXECUTE format('REVOKE ALL ON FUNCTION %1$I.platform_announcement_publisher_tick(integer),%1$I.platform_announcement_publisher_status(),%1$I.platform_announcement_document(%1$I.platform_announcements,timestamptz),%1$I.platform_announcement_change(text,jsonb),%1$I.platform_announcement_read(text,jsonb) FROM PUBLIC',s);
  -- Strip inherited default grants on newly introduced functions, preserving explicit grants on reapply.
  FOR g IN SELECT p.proname,pg_get_function_identity_arguments(p.oid) args,a.grantee FROM pg_proc p,
    LATERAL aclexplode(p.proacl) a WHERE p.pronamespace=s::regnamespace AND p.proname IN ('platform_announcement_publisher_tick','platform_announcement_publisher_status')
      AND NOT p.oid=ANY(existing_functions) AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM %I',s,g.proname,g.args,pg_get_userbyid(g.grantee)); END LOOP;
END $migration$;
COMMIT;
