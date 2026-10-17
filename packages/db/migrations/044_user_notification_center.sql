-- C: shared announcement projection + existing personal notifications. No fanout or scheduler.
-- Requires 028/031/034/036/037/041/042/043; execute as trusted migration owner after backup.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE IF NOT EXISTS platform_notification_center_requests (
  organization_id text NOT NULL,
  user_id text NOT NULL,
  request_id uuid NOT NULL,
  updated integer NOT NULL CHECK(updated>=0),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(organization_id,user_id,request_id),
  FOREIGN KEY(organization_id,user_id) REFERENCES organization_members(organization_id,user_id) ON DELETE CASCADE
);
ALTER TABLE platform_notification_center_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_notification_center_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_notification_center_requests FROM PUBLIC;
CREATE INDEX IF NOT EXISTS platform_announcements_center_idx ON platform_announcements(pinned DESC,published_at DESC,id) WHERE status IN ('published','expired');

DO $migration$
DECLARE s text:=current_schema(); existing_functions oid[]; acl record;
BEGIN
  SELECT coalesce(array_agg(p.oid),'{}'::oid[]) INTO existing_functions FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=s AND p.proname LIKE 'platform_notification_center_%';
  FOR acl IN SELECT a.grantee FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,LATERAL aclexplode(c.relacl) a
    WHERE n.nspname=s AND c.relname='platform_notification_center_requests' AND a.grantee<>0 AND a.grantee<>c.relowner
  LOOP EXECUTE format('REVOKE ALL ON TABLE %I.platform_notification_center_requests FROM %I',s,pg_get_userbyid(acl.grantee)); END LOOP;

  EXECUTE format($definition$
  CREATE OR REPLACE FUNCTION %1$I.platform_notification_center_access(p_actor text,p_org text,p_write boolean) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
  DECLARE state text;
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM %1$I.organization_members m JOIN %1$I.organizations o ON o.id=m.organization_id
      WHERE m.user_id=p_actor AND m.organization_id=p_org AND o.kind='personal') THEN RETURN 'not_found'; END IF;
    state:=%1$I.platform_account_access(p_actor)->>'status';
    IF state IS NULL OR state='banned' THEN RETURN 'account_banned'; END IF;
    IF p_write AND state<>'active' THEN RETURN 'account_read_only'; END IF;
    RETURN NULL;
  END $body$
  $definition$,s);

  EXECUTE format($definition$
  CREATE OR REPLACE FUNCTION %1$I.platform_notification_center_rows(p_actor text,p_org text,at_time timestamptz)
  RETURNS TABLE(id text,source text,reference_id text,type text,title text,body text,is_read boolean,read_at timestamptz,
    created_at timestamptz,pinned boolean,severity text,status text,expires_at timestamptz)
  LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $body$
    SELECT 'announcement:'||a.id::text,'announcement',a.id::text,'announcement',a.title,left(a.body,240),r.read_at IS NOT NULL,r.read_at,
      a.published_at,a.pinned AND a.status='published' AND (a.expires_at IS NULL OR a.expires_at>at_time),a.severity,
      CASE WHEN a.status='expired' OR a.expires_at<=at_time THEN 'expired' ELSE 'published' END,a.expires_at
    FROM %1$I.platform_announcements a LEFT JOIN %1$I.platform_announcement_receipts r
      ON r.announcement_id=a.id AND r.user_id=p_actor AND r.organization_id=p_org
    WHERE a.status IN ('published','expired') AND a.published_at<=at_time
    UNION ALL
    SELECT n.id,'notification',n.id,n.type,n.title,n.body,n.is_read,n.read_at,n.created_at,false,'normal','published',NULL::timestamptz
    FROM %1$I.user_notifications n WHERE n.user_id=p_actor AND n.organization_id=p_org
  $body$
  $definition$,s);

  EXECUTE format($definition$
  CREATE OR REPLACE FUNCTION %1$I.platform_notification_center_read(p_actor text,p_org text,q jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
  DECLARE failure text; n integer; records jsonb; unread bigint; c jsonb; cursor_time timestamptz;
  BEGIN
    IF q IS NULL OR jsonb_typeof(q)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(q) k WHERE k NOT IN ('source','read','history','limit','cursor'))
      OR (q ? 'source' AND (jsonb_typeof(q->'source') IS DISTINCT FROM 'string' OR q->>'source' NOT IN ('all','announcement','notification')))
      OR (q ? 'read' AND (jsonb_typeof(q->'read') IS DISTINCT FROM 'string' OR q->>'read' NOT IN ('all','unread','read')))
      OR (q ? 'history' AND jsonb_typeof(q->'history') IS DISTINCT FROM 'boolean')
      OR (q ? 'limit' AND (jsonb_typeof(q->'limit') IS DISTINCT FROM 'number' OR q->>'limit' !~ '^[1-9][0-9]{0,2}$'))
      THEN RAISE EXCEPTION 'invalid_notification_query' USING ERRCODE='22023'; END IF;
    n:=coalesce((q->>'limit')::integer,25);
    IF n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_notification_query' USING ERRCODE='22023'; END IF;
    IF q ? 'cursor' THEN
      c:=q->'cursor';
      IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>4
        OR jsonb_typeof(c->'pinned') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(c->'createdAt') IS DISTINCT FROM 'string' OR c->>'createdAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
        OR jsonb_typeof(c->'source') IS DISTINCT FROM 'string' OR c->>'source' NOT IN ('announcement','notification')
        OR jsonb_typeof(c->'referenceId') IS DISTINCT FROM 'string' OR c->>'referenceId' !~ '^[a-zA-Z0-9-]{1,128}$'
        THEN RAISE EXCEPTION 'invalid_notification_query' USING ERRCODE='22023'; END IF;
      BEGIN cursor_time:=(c->>'createdAt')::timestamptz;
      EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'invalid_notification_query' USING ERRCODE='22023'; END;
    END IF;
    failure:=%1$I.platform_notification_center_access(p_actor,p_org,false);
    IF failure IS NOT NULL THEN RETURN jsonb_build_object('error',failure); END IF;
    WITH all_rows AS MATERIALIZED(SELECT * FROM %1$I.platform_notification_center_rows(p_actor,p_org,clock_timestamp())),
    page AS(SELECT * FROM all_rows r WHERE (coalesce((q->>'history')::boolean,false) OR status<>'expired')
      AND (coalesce(q->>'source','all')='all' OR source=q->>'source')
      AND (coalesce(q->>'read','all')='all' OR is_read=(q->>'read'='read'))
      AND (coalesce(q->>'read','all')<>'unread' OR status='published')
      AND (c IS NULL OR (NOT pinned, -extract(epoch FROM created_at),source COLLATE "C",reference_id COLLATE "C")
        > (NOT (c->>'pinned')::boolean,-extract(epoch FROM cursor_time),(c->>'source') COLLATE "C",(c->>'referenceId') COLLATE "C"))
      ORDER BY pinned DESC,created_at DESC,source COLLATE "C",reference_id COLLATE "C" LIMIT n+1)
    SELECT (SELECT count(*) FROM all_rows WHERE status='published' AND NOT is_read),
      coalesce(jsonb_agg(jsonb_build_object('id',id,'source',source,'referenceId',reference_id,'type',type,'title',title,'body',body,
        'isRead',is_read,'readAt',read_at,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'pinned',pinned,'severity',severity,'status',status,'expiresAt',expires_at)
        ORDER BY pinned DESC,created_at DESC,source COLLATE "C",reference_id COLLATE "C"),'[]'::jsonb)
      INTO unread,records FROM page;
    RETURN jsonb_build_object('notifications',CASE WHEN jsonb_array_length(records)>n THEN records-n ELSE records END,
      'hasMore',jsonb_array_length(records)>n,'unreadCount',unread);
  END $body$
  $definition$,s);

  EXECUTE format($definition$
  CREATE OR REPLACE FUNCTION %1$I.platform_notification_center_mark(p_actor text,p_org text,p_id text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
  DECLARE failure text; at_time timestamptz; updated integer:=0; unread bigint; found_id text;
  BEGIN
    IF p_id IS NULL OR length(p_id)>141 OR (p_id !~ '^[a-zA-Z0-9-]{1,128}$' AND p_id !~ '^announcement:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      THEN RETURN jsonb_build_object('error','not_found'); END IF;
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
    failure:=%1$I.platform_notification_center_access(p_actor,p_org,true);
    IF failure IS NOT NULL THEN RETURN jsonb_build_object('error',failure); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:notification:scope:'||jsonb_build_array(p_org,p_actor)::text,0));
    IF left(p_id,13)='announcement:' THEN
      PERFORM 1 FROM %1$I.platform_announcements WHERE id=substring(p_id FROM 14)::uuid FOR SHARE;
      at_time:=clock_timestamp();
      IF NOT EXISTS(SELECT 1 FROM %1$I.platform_announcements WHERE id=substring(p_id FROM 14)::uuid AND status='published'
        AND published_at<=at_time AND (expires_at IS NULL OR expires_at>at_time)) THEN RETURN jsonb_build_object('error','not_found'); END IF;
      INSERT INTO %1$I.platform_announcement_receipts(announcement_id,organization_id,user_id,read_at)
        VALUES(substring(p_id FROM 14)::uuid,p_org,p_actor,at_time) ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS updated=ROW_COUNT;
    ELSE
      SELECT id INTO found_id FROM %1$I.user_notifications WHERE id=p_id AND user_id=p_actor AND organization_id=p_org FOR UPDATE;
      IF NOT FOUND THEN RETURN jsonb_build_object('error','not_found'); END IF;
      UPDATE %1$I.user_notifications SET is_read=true,read_at=clock_timestamp() WHERE id=found_id AND NOT is_read;
      GET DIAGNOSTICS updated=ROW_COUNT;
    END IF;
    SELECT count(*) INTO unread FROM %1$I.platform_notification_center_rows(p_actor,p_org,clock_timestamp()) WHERE status='published' AND NOT is_read;
    RETURN jsonb_build_object('ok',true,'updated',updated,'unreadCount',unread);
  END $body$
  $definition$,s);

  EXECUTE format($definition$
  CREATE OR REPLACE FUNCTION %1$I.platform_notification_center_all(p_actor text,p_org text,p_request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
  DECLARE failure text; previous integer; changed integer; unread bigint; at_time timestamptz;
  BEGIN
    IF p_request IS NULL OR p_request::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN RAISE EXCEPTION 'invalid_notification_input' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('%1$I:governance:changes',0));
    failure:=%1$I.platform_notification_center_access(p_actor,p_org,true);
    IF failure IS NOT NULL THEN RETURN jsonb_build_object('error',failure); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('%1$I:notification:scope:'||jsonb_build_array(p_org,p_actor)::text,0));
    SELECT r.updated INTO previous FROM %1$I.platform_notification_center_requests r WHERE r.organization_id=p_org AND r.user_id=p_actor AND r.request_id=p_request;
    IF FOUND THEN
      SELECT count(*) INTO unread FROM %1$I.platform_notification_center_rows(p_actor,p_org,clock_timestamp()) WHERE status='published' AND NOT is_read;
      RETURN jsonb_build_object('ok',true,'updated',previous,'unreadCount',unread,'replayed',true);
    END IF;
    -- Share publication rows with withdrawal and lock in UUID order. Time is sampled after lock waits.
    PERFORM 1 FROM %1$I.platform_announcements WHERE status='published' ORDER BY id FOR SHARE;
    at_time:=clock_timestamp();
    -- One statement snapshot chooses both sources. Failure in either mutation/request persistence rolls everything back.
    WITH candidates AS MATERIALIZED(SELECT * FROM %1$I.platform_notification_center_rows(p_actor,p_org,at_time) WHERE status='published' AND NOT is_read),
    announcements AS(INSERT INTO %1$I.platform_announcement_receipts(announcement_id,organization_id,user_id,read_at)
      SELECT reference_id::uuid,p_org,p_actor,at_time FROM candidates WHERE source='announcement' ON CONFLICT DO NOTHING RETURNING 1),
    notifications AS(UPDATE %1$I.user_notifications n SET is_read=true,read_at=at_time FROM candidates c
      WHERE c.source='notification' AND n.id=c.reference_id AND n.user_id=p_actor AND n.organization_id=p_org AND NOT n.is_read RETURNING 1)
    SELECT (SELECT count(*) FROM announcements)+(SELECT count(*) FROM notifications) INTO changed;
    INSERT INTO %1$I.platform_notification_center_requests(organization_id,user_id,request_id,updated,occurred_at) VALUES(p_org,p_actor,p_request,changed,at_time);
    SELECT count(*) INTO unread FROM %1$I.platform_notification_center_rows(p_actor,p_org,clock_timestamp()) WHERE status='published' AND NOT is_read;
    RETURN jsonb_build_object('ok',true,'updated',changed,'unreadCount',unread,'replayed',false);
  END $body$
  $definition$,s);

  EXECUTE format('REVOKE ALL ON FUNCTION %1$I.platform_notification_center_access(text,text,boolean),%1$I.platform_notification_center_rows(text,text,timestamptz),%1$I.platform_notification_center_read(text,text,jsonb),%1$I.platform_notification_center_mark(text,text,text),%1$I.platform_notification_center_all(text,text,uuid) FROM PUBLIC',s);
  FOR acl IN SELECT p.oid,p.proname,pg_get_function_identity_arguments(p.oid) args,a.grantee FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,LATERAL aclexplode(p.proacl) a
    WHERE n.nspname=s AND p.proname LIKE 'platform_notification_center_%' AND NOT p.oid=ANY(existing_functions) AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM %I',s,acl.proname,acl.args,pg_get_userbyid(acl.grantee)); END LOOP;
END $migration$;
COMMIT;
