-- 公告 A 底座。依赖 001/031/032/034/036/037；不依赖 033/038/Runtime。
-- 由受信任 DBA 备份后执行。函数所有者须有 FORCE RLS 跨表权限；不给应用表权限。
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS platform_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120 AND title !~ '[[:cntrl:]]' AND length(btrim(title)) > 0),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000 AND length(btrim(body,E' \t\n\r')) > 0),
  severity text NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal','important')),
  pinned boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published','withdrawn','expired')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  scheduled_at timestamptz,
  scheduled_by text REFERENCES users(id) ON DELETE RESTRICT,
  schedule_governance_version integer CHECK (schedule_governance_version >= 0),
  published_at timestamptz,
  expires_at timestamptz,
  expiry_days integer DEFAULT 30 CHECK (expiry_days = 30),
  withdrawn_at timestamptz,
  withdrawn_by text REFERENCES users(id) ON DELETE RESTRICT,
  withdrawal_reason text CHECK (length(withdrawal_reason) BETWEEN 1 AND 500 AND withdrawal_reason !~ '[[:cntrl:]]'),
  CHECK ((status = 'scheduled') = (scheduled_at IS NOT NULL AND scheduled_by IS NOT NULL AND schedule_governance_version IS NOT NULL) OR status IN ('published','withdrawn','expired')),
  CHECK ((status IN ('published','withdrawn')) = (published_at IS NOT NULL) OR status = 'expired'),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL AND withdrawal_reason IS NOT NULL)),
  CHECK (expires_at IS NULL OR published_at IS NULL OR expires_at > published_at),
  CHECK (expires_at IS NULL OR scheduled_at IS NULL OR expires_at > scheduled_at)
);
CREATE INDEX IF NOT EXISTS platform_announcements_due_idx ON platform_announcements(scheduled_at,id) WHERE status='scheduled';
CREATE INDEX IF NOT EXISTS platform_announcements_state_idx ON platform_announcements(status,id);
CREATE INDEX IF NOT EXISTS platform_announcements_published_idx ON platform_announcements(id) WHERE status IN ('published','expired');

CREATE TABLE IF NOT EXISTS platform_announcement_receipts (
  announcement_id uuid NOT NULL REFERENCES platform_announcements(id) ON DELETE RESTRICT,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,user_id,announcement_id),
  FOREIGN KEY (organization_id,user_id) REFERENCES organization_members(organization_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS platform_announcement_requests (
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  input jsonb NOT NULL CHECK (jsonb_typeof(input)='object'),
  announcement_id uuid NOT NULL REFERENCES platform_announcements(id) ON DELETE RESTRICT,
  result jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id,request_id)
);
CREATE TABLE IF NOT EXISTS platform_announcement_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  announcement_id uuid NOT NULL REFERENCES platform_announcements(id) ON DELETE RESTRICT,
  actor_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  executor_type text NOT NULL CHECK (executor_type IN ('admin','system')),
  action text NOT NULL CHECK (action IN ('created','draft_updated','schedule_set','schedule_cancelled','published','withdrawn','expired','publish_blocked')),
  request_id uuid,
  previous_version integer NOT NULL CHECK (previous_version >= 0),
  version integer NOT NULL CHECK (version > previous_version),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  changed_fields jsonb NOT NULL CHECK (jsonb_typeof(changed_fields)='array'),
  scheduled_at timestamptz,
  published_at timestamptz,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_user_id,request_id)
);
CREATE INDEX IF NOT EXISTS platform_announcement_audit_page_idx ON platform_announcement_audit(announcement_id,id DESC);

ALTER TABLE platform_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_announcements FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_announcement_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_announcement_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_announcement_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_announcement_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_announcement_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_announcement_audit FORCE ROW LEVEL SECURITY;
-- No direct-table policies: both shared projections and personal receipts use the bounded functions below.
REVOKE ALL ON platform_announcements,platform_announcement_receipts,platform_announcement_requests,platform_announcement_audit FROM PUBLIC;
REVOKE ALL ON SEQUENCE platform_announcement_audit_id_seq FROM PUBLIC;

DO $migration$
DECLARE s text := current_schema(); existing_functions oid[]; grant_record record;
BEGIN
  SELECT coalesce(array_agg(p.oid),'{}'::oid[]) INTO existing_functions FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=s AND p.proname IN ('platform_announcement_document','platform_announcement_validate','platform_announcement_change','platform_announcement_read','platform_announcement_user_read','platform_announcement_mark_read');
  -- ALTER DEFAULT PRIVILEGES may have granted app roles ALL (including TRUNCATE, which bypasses RLS).
  -- These new private tables/sequence intentionally have no non-owner direct privileges, including on reapply.
  FOR grant_record IN
    SELECT c.relname,c.relkind,a.grantee FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
      LATERAL aclexplode(c.relacl) a WHERE n.nspname=s AND c.relname IN ('platform_announcements','platform_announcement_receipts','platform_announcement_requests','platform_announcement_audit','platform_announcement_audit_id_seq')
      AND a.grantee<>0 AND a.grantee<>c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON %s %I.%I FROM %I',CASE WHEN grant_record.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,s,grant_record.relname,pg_get_userbyid(grant_record.grantee));
  END LOOP;
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_document(a %1$I.platform_announcements, at_time timestamptz) RETURNS jsonb
    LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $body$
      SELECT jsonb_build_object('id',a.id,'title',a.title,'body',a.body,'severity',a.severity,'pinned',a.pinned,
        'status',CASE WHEN a.status='published' AND a.expires_at<=at_time THEN 'expired' ELSE a.status END,
        'version',a.version,'createdBy',a.created_by,'updatedBy',a.updated_by,'createdAt',a.created_at,'updatedAt',a.updated_at,
        'scheduledAt',a.scheduled_at,'scheduledBy',a.scheduled_by,'scheduleGovernanceVersion',a.schedule_governance_version,
        'publishedAt',a.published_at,'expiresAt',a.expires_at,'expiryDays',a.expiry_days,
        'withdrawnAt',a.withdrawn_at,'withdrawnBy',a.withdrawn_by,'withdrawalReason',a.withdrawal_reason)
    $body$
  $definition$,s);

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
          allowed := allowed || ARRAY['title','body','severity','pinned','expiresAt'];
          IF jsonb_typeof(p->'title') IS DISTINCT FROM 'string' OR length(p->>'title') NOT BETWEEN 1 AND 120
            OR length(btrim(p->>'title'))=0 OR (p->>'title') ~ '[[:cntrl:]]'
            OR jsonb_typeof(p->'body') IS DISTINCT FROM 'string' OR length(p->>'body') NOT BETWEEN 1 AND 20000
            OR length(btrim(p->>'body',E' \t\n\r'))=0 OR (replace(replace(p->>'body',E'\n',''),E'\t','')) ~ '[[:cntrl:]]'
            OR (p ? 'severity' AND (jsonb_typeof(p->'severity')<>'string' OR (p->>'severity') NOT IN ('normal','important')))
            OR (p ? 'pinned' AND jsonb_typeof(p->'pinned')<>'boolean')
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

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_read(p_actor text,q jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE records jsonb; n integer; at_time timestamptz:=clock_timestamp(); item jsonb;
    BEGIN
      PERFORM %1$I.platform_announcement_validate(q,false,true);
      n:=coalesce((q->>'limit')::integer,25);
      IF %1$I.platform_account_access(p_actor)->>'status' IS DISTINCT FROM 'active'
        OR NOT EXISTS(SELECT 1 FROM %1$I.platform_role_bindings WHERE user_id=p_actor AND revoked_at IS NULL AND role IN ('platform_admin','platform_operator','platform_viewer'))
        THEN RETURN jsonb_build_object('error','platform_role_required'); END IF;
      IF q ? 'id' THEN
        SELECT %1$I.platform_announcement_document(a,at_time) INTO item FROM %1$I.platform_announcements a WHERE id=(q->>'id')::uuid;
        IF item IS NULL THEN RETURN jsonb_build_object('error','not_found'); END IF;
        IF coalesce((q->>'audit')::boolean,false)=false THEN RETURN jsonb_build_object('announcement',item); END IF;
        SELECT coalesce(jsonb_agg(payload ORDER BY page_id DESC),'[]'::jsonb) INTO records FROM (
          SELECT e.id page_id,jsonb_build_object('id',e.id::text,'announcementId',e.announcement_id,'actorUserId',e.actor_user_id,'executorType',e.executor_type,
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
          ORDER BY a.id LIMIT n+1
        ) page;
      END IF;
      RETURN jsonb_build_object('items',CASE WHEN jsonb_array_length(records)>n THEN records-n ELSE records END,
        'nextCursor',CASE WHEN jsonb_array_length(records)>n THEN records->(n-1)->>'id' ELSE NULL END);
    END $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_user_read(p_actor text,p_org text,q jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE records jsonb; n integer; at_time timestamptz:=clock_timestamp(); unread bigint; state text;
    BEGIN
      PERFORM %1$I.platform_announcement_validate(q,true,true);
      n:=coalesce((q->>'limit')::integer,25);
      IF NOT EXISTS(SELECT 1 FROM %1$I.organization_members m JOIN %1$I.organizations o ON o.id=m.organization_id WHERE m.user_id=p_actor AND m.organization_id=p_org AND o.kind='personal')
        THEN RETURN jsonb_build_object('error','not_found'); END IF;
      state:=%1$I.platform_account_access(p_actor)->>'status';
      IF state IS NULL OR state='banned' THEN RETURN jsonb_build_object('error','account_banned'); END IF;
      SELECT count(*) INTO unread FROM %1$I.platform_announcements a WHERE a.status='published' AND a.published_at<=at_time AND (a.expires_at IS NULL OR a.expires_at>at_time)
        AND NOT EXISTS(SELECT 1 FROM %1$I.platform_announcement_receipts r WHERE r.announcement_id=a.id AND r.user_id=p_actor AND r.organization_id=p_org);
      SELECT coalesce(jsonb_agg(payload ORDER BY page_id),'[]'::jsonb) INTO records FROM (
        SELECT a.id page_id,jsonb_build_object('id',a.id,'title',a.title,'body',a.body,'severity',a.severity,'pinned',a.pinned,
          'status',CASE WHEN a.status='expired' OR a.expires_at<=at_time THEN 'expired' ELSE 'published' END,
          'publishedAt',a.published_at,'expiresAt',a.expires_at,'isRead',EXISTS(SELECT 1 FROM %1$I.platform_announcement_receipts r WHERE r.announcement_id=a.id AND r.user_id=p_actor AND r.organization_id=p_org)) payload
        FROM %1$I.platform_announcements a WHERE a.status IN ('published','expired') AND a.published_at<=at_time
          AND (coalesce((q->>'history')::boolean,false) OR (a.status='published' AND (a.expires_at IS NULL OR a.expires_at>at_time)))
          AND (NOT q ? 'id' OR a.id=(q->>'id')::uuid) AND (NOT q ? 'after' OR a.id>(q->>'after')::uuid)
        ORDER BY a.id LIMIT n+1
      ) page;
      IF q ? 'id' THEN
        IF jsonb_array_length(records)=0 THEN RETURN jsonb_build_object('error','not_found'); END IF;
        RETURN jsonb_build_object('announcement',records->0,'unreadCount',unread);
      END IF;
      RETURN jsonb_build_object('items',CASE WHEN jsonb_array_length(records)>n THEN records-n ELSE records END,
        'nextCursor',CASE WHEN jsonb_array_length(records)>n THEN records->(n-1)->>'id' ELSE NULL END,'unreadCount',unread);
    END $body$
  $definition$,s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_mark_read(p_actor text,p_org text,p_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE state text; at_time timestamptz; result jsonb;
    BEGIN
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
      IF p_id IS NULL OR NOT EXISTS(SELECT 1 FROM %1$I.organization_members m JOIN %1$I.organizations o ON o.id=m.organization_id WHERE m.user_id=p_actor AND m.organization_id=p_org AND o.kind='personal')
        THEN RETURN jsonb_build_object('error','not_found'); END IF;
      state:=%1$I.platform_account_access(p_actor)->>'status';
      IF state IS NULL OR state='banned' THEN RETURN jsonb_build_object('error','account_banned'); END IF;
      IF state<>'active' THEN RETURN jsonb_build_object('error','account_read_only'); END IF;
      -- Share row lock with withdrawal; use clock only after lock acquisition.
      PERFORM 1 FROM %1$I.platform_announcements WHERE id=p_id FOR SHARE;
      at_time:=clock_timestamp();
      IF NOT EXISTS(SELECT 1 FROM %1$I.platform_announcements WHERE id=p_id AND status='published' AND published_at<=at_time AND (expires_at IS NULL OR expires_at>at_time))
        THEN RETURN jsonb_build_object('error','not_found'); END IF;
      INSERT INTO %1$I.platform_announcement_receipts(announcement_id,organization_id,user_id,read_at) VALUES(p_id,p_org,p_actor,at_time) ON CONFLICT DO NOTHING;
      result:=%1$I.platform_announcement_user_read(p_actor,p_org,'{"limit":1}'::jsonb);
      RETURN jsonb_build_object('id',p_id,'isRead',true,'unreadCount',result->'unreadCount');
    END $body$
  $definition$,s);

  EXECUTE format('REVOKE ALL ON FUNCTION %1$I.platform_announcement_document(%1$I.platform_announcements,timestamptz),%1$I.platform_announcement_validate(jsonb,boolean,boolean),%1$I.platform_announcement_change(text,jsonb),%1$I.platform_announcement_read(text,jsonb),%1$I.platform_announcement_user_read(text,text,jsonb),%1$I.platform_announcement_mark_read(text,text,uuid) FROM PUBLIC',s);
  -- Strip inherited default EXECUTE grants only on newly created functions. Explicit existing grants survive reapply.
  FOR grant_record IN
    SELECT p.oid,p.proname,pg_get_function_identity_arguments(p.oid) args,a.grantee FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
      LATERAL aclexplode(p.proacl) a WHERE n.nspname=s AND p.proname IN ('platform_announcement_document','platform_announcement_validate','platform_announcement_change','platform_announcement_read','platform_announcement_user_read','platform_announcement_mark_read')
      AND NOT p.oid=ANY(existing_functions) AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM %I',s,grant_record.proname,grant_record.args,pg_get_userbyid(grant_record.grantee));
  END LOOP;
END $migration$;
COMMIT;
