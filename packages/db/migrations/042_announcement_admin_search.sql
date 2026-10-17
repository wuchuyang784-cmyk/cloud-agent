-- 公告 B：只替换 041 的受限管理员读取函数以支持标题搜索；保留签名、OID、所有权和显式授权。
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $migration$
DECLARE s text:=current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_announcement_read(p_actor text,q jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET row_security=off AS $body$
    DECLARE records jsonb; n integer; at_time timestamptz:=clock_timestamp(); item jsonb;
    BEGIN
      IF q ? 'q' AND (jsonb_typeof(q->'q') IS DISTINCT FROM 'string' OR length(q->>'q')>200 OR (q->>'q') ~ '[[:cntrl:]]') THEN
        RAISE EXCEPTION 'invalid_announcement_query' USING ERRCODE='22023';
      END IF;
      PERFORM %1$I.platform_announcement_validate(q-'q',false,true);
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
            AND (NOT q ? 'q' OR strpos(lower(a.title),lower(q->>'q'))>0)
          ORDER BY a.id LIMIT n+1
        ) page;
      END IF;
      RETURN jsonb_build_object('items',CASE WHEN jsonb_array_length(records)>n THEN records-n ELSE records END,
        'nextCursor',CASE WHEN jsonb_array_length(records)>n THEN records->(n-1)->>'id' ELSE NULL END);
    END $body$
  $definition$,s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_announcement_read(text,jsonb) FROM PUBLIC',s);
END $migration$;
COMMIT;
