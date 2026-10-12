-- C 批：仅保存最新基础设施快照，不依赖 033，不开放 Agent 执行。
-- 由受信任 DBA 执行。采集源与登录角色由 DBA 单独配置；迁移不创建账号。
BEGIN;
CREATE TABLE IF NOT EXISTS platform_infrastructure_sources (
  source_id text PRIMARY KEY CHECK (source_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 100 AND label !~ '[[:cntrl:]]'),
  login_role name UNIQUE NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_infrastructure_snapshots (
  source_id text PRIMARY KEY REFERENCES platform_infrastructure_sources(source_id) ON DELETE CASCADE,
  sampled_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144)
);
ALTER TABLE platform_infrastructure_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_infrastructure_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_infrastructure_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_infrastructure_snapshots FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform_infrastructure_sources, platform_infrastructure_snapshots FROM PUBLIC;
ALTER TABLE platform_admin_audit DROP CONSTRAINT platform_admin_audit_action_check;
ALTER TABLE platform_admin_audit ADD CONSTRAINT platform_admin_audit_action_check
  CHECK (action IN ('role_changed','users_read','agents_read','infrastructure_read'));

DO $migration$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_infrastructure_report(p_payload jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
    DECLARE source text; sample_time timestamptz; changed integer;
    BEGIN
      SELECT source_id INTO source FROM %1$I.platform_infrastructure_sources
        WHERE login_role = session_user AND enabled FOR SHARE;
      IF source IS NULL THEN RAISE EXCEPTION 'collector_not_registered' USING ERRCODE = '42501'; END IF;
      IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
        OR octet_length(p_payload::text) > 262144 OR p_payload->>'version' IS DISTINCT FROM '1'
        OR jsonb_typeof(p_payload->'host') IS DISTINCT FROM 'object'
        OR jsonb_typeof(p_payload->'swarm') IS DISTINCT FROM 'object'
        OR jsonb_typeof(p_payload->'sampledAt') IS DISTINCT FROM 'string'
        OR p_payload->>'sampledAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        THEN RAISE EXCEPTION 'invalid_snapshot' USING ERRCODE = '22023'; END IF;
      sample_time := (p_payload->>'sampledAt')::timestamptz;
      IF NOT isfinite(sample_time)
        OR to_char(sample_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p_payload->>'sampledAt'
        OR sample_time > clock_timestamp() + interval '10 seconds'
        OR sample_time < clock_timestamp() - interval '60 seconds'
        THEN RAISE EXCEPTION 'invalid_sample_time' USING ERRCODE = '22023'; END IF;
      INSERT INTO %1$I.platform_infrastructure_snapshots AS old(source_id, sampled_at, received_at, payload)
        VALUES(source, sample_time, clock_timestamp(), p_payload)
        ON CONFLICT (source_id) DO UPDATE SET sampled_at = EXCLUDED.sampled_at,
          received_at = EXCLUDED.received_at, payload = EXCLUDED.payload
        WHERE old.sampled_at < EXCLUDED.sampled_at;
      GET DIAGNOSTICS changed = ROW_COUNT;
      RETURN changed = 1;
    END; $body$
  $definition$, s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_infrastructure_report(jsonb) FROM PUBLIC', s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_infrastructure_read(p_actor text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
    DECLARE records jsonb;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM %1$I.platform_role_bindings WHERE user_id = p_actor AND revoked_at IS NULL
        AND role IN ('platform_viewer','platform_operator','platform_admin')) THEN RETURN NULL; END IF;
      SELECT coalesce(jsonb_agg(item ORDER BY source_id), '[]'::jsonb) INTO records FROM (
        SELECT src.source_id, jsonb_build_object('sourceId',src.source_id,'label',src.label,
          'sampledAt',snap.sampled_at,'receivedAt',snap.received_at,'payload',snap.payload) AS item
        FROM %1$I.platform_infrastructure_sources src LEFT JOIN %1$I.platform_infrastructure_snapshots snap USING(source_id)
        WHERE src.enabled ORDER BY src.source_id LIMIT 20
      ) rows;
      INSERT INTO %1$I.platform_admin_audit(actor_user_id,action,row_count)
        VALUES(p_actor,'infrastructure_read',jsonb_array_length(records));
      RETURN jsonb_build_object('items',records,'truncated',
        EXISTS(SELECT 1 FROM %1$I.platform_infrastructure_sources WHERE enabled OFFSET 20 LIMIT 1));
    END; $body$
  $definition$, s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_infrastructure_read(text) FROM PUBLIC', s);
END;
$migration$;
COMMIT;
