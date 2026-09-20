-- 双端平台 A 批：独立平台角色、受限全局只读查询与访问记录。
-- 由受信任 DBA 执行；函数所有者需要跨 FORCE RLS 读取权限，应用账号禁止 BYPASSRLS。
BEGIN;

CREATE TABLE IF NOT EXISTS platform_role_bindings (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('platform_viewer', 'platform_operator', 'platform_admin')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by text NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  revoked_at timestamptz
);
ALTER TABLE platform_role_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_role_bindings FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id text,
  action text NOT NULL CHECK (action IN ('role_changed', 'users_read', 'agents_read')),
  target_user_id text,
  row_count integer,
  database_actor text NOT NULL DEFAULT session_user,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_admin_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_audit FORCE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS platform_admin_audit_time_idx ON platform_admin_audit(occurred_at DESC);
CREATE INDEX IF NOT EXISTS agents_admin_owner_id_idx ON agents(owner_user_id, id COLLATE "C");
CREATE INDEX IF NOT EXISTS agents_admin_status_id_idx ON agents(status, id COLLATE "C");
CREATE INDEX IF NOT EXISTS agents_admin_id_idx ON agents(id COLLATE "C");
CREATE INDEX IF NOT EXISTS users_admin_id_idx ON users(id COLLATE "C");

-- 在迁移时固定真实 schema；调用者的 search_path / 临时表不能改变权限判断。
DO $migration$
DECLARE s text := current_schema();
BEGIN
  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_admin_role_audit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
    BEGIN
      INSERT INTO %1$I.platform_admin_audit(action, target_user_id)
      VALUES ('role_changed', CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END);
      RETURN NULL;
    END;
    $body$
  $definition$, s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_admin_role_audit() FROM PUBLIC', s);
  EXECUTE format('DROP TRIGGER IF EXISTS platform_role_change ON %I.platform_role_bindings', s);
  EXECUTE format('CREATE TRIGGER platform_role_change AFTER INSERT OR UPDATE OR DELETE ON %I.platform_role_bindings FOR EACH ROW EXECUTE FUNCTION %I.platform_admin_role_audit()', s, s);

  EXECUTE format($definition$
    CREATE OR REPLACE FUNCTION %1$I.platform_admin_read(
      p_actor text, p_resource text, p_query text DEFAULT '', p_after text DEFAULT '',
      p_limit integer DEFAULT 25, p_owner text DEFAULT '', p_status text DEFAULT ''
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp SET row_security = off AS $body$
    DECLARE
      actor_role text;
      payload jsonb;
      records jsonb;
      result_count integer;
    BEGIN
      SELECT role INTO actor_role FROM %1$I.platform_role_bindings
        WHERE user_id = p_actor AND revoked_at IS NULL;
      IF actor_role IS NULL THEN RETURN NULL; END IF;
      IF p_resource IS NULL OR p_resource NOT IN ('me','users','agents')
        OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
        OR p_query IS NULL OR p_after IS NULL OR p_owner IS NULL OR p_status IS NULL
        OR length(p_query) > 200 OR length(p_after) > 200 OR length(p_owner) > 200
        OR p_status NOT IN ('','uninitialized','provisioning','starting','ready','degraded','offline','failed','stopped')
        THEN RAISE EXCEPTION 'invalid_admin_query' USING ERRCODE = '22023'; END IF;
      IF p_resource = 'me' THEN
        SELECT jsonb_build_object('role', actor_role, 'permissions', jsonb_build_array('users:read','agents:read'),
          'user', jsonb_build_object('id', u.id, 'email', u.email, 'displayName', u.display_name,
            'createdAt', u.created_at, 'authLinked', coalesce(starts_with(u.auth_subject, 'better-auth:'), false)))
          INTO payload FROM %1$I.users u WHERE u.id = p_actor;
        RETURN payload;
      END IF;
      IF p_resource = 'users' THEN
        SELECT coalesce(jsonb_agg(item ORDER BY id COLLATE "C"), '[]'::jsonb) INTO records FROM (
          SELECT u.id, jsonb_build_object('id',u.id,'email',u.email,'displayName',u.display_name,
            'createdAt',u.created_at,'authLinked',coalesce(starts_with(u.auth_subject,'better-auth:'),false)) AS item
          FROM %1$I.users u
          WHERE u.id COLLATE "C" > p_after COLLATE "C"
            AND (p_query = '' OR strpos(lower(u.email), lower(p_query)) > 0
              OR strpos(lower(u.id),lower(p_query)) > 0 OR strpos(lower(u.display_name),lower(p_query)) > 0)
          ORDER BY u.id COLLATE "C" LIMIT p_limit + 1
        ) rows;
      ELSE
        SELECT coalesce(jsonb_agg(item ORDER BY id COLLATE "C"), '[]'::jsonb) INTO records FROM (
          SELECT a.id, jsonb_build_object('id',a.id,'name',a.name,'organizationId',a.organization_id,
            'ownerUserId',a.owner_user_id,'ownerEmail',u.email,'status',a.status,'engine',a.engine,
            'createdAt',a.created_at,'updatedAt',a.updated_at) AS item
          FROM %1$I.agents a JOIN %1$I.users u ON u.id = a.owner_user_id
          WHERE a.id COLLATE "C" > p_after COLLATE "C"
            AND (p_owner = '' OR a.owner_user_id = p_owner) AND (p_status = '' OR a.status = p_status)
            AND (p_query = '' OR strpos(lower(a.name),lower(p_query)) > 0
              OR strpos(lower(a.id),lower(p_query)) > 0 OR strpos(lower(u.email),lower(p_query)) > 0)
          ORDER BY a.id COLLATE "C" LIMIT p_limit + 1
        ) rows;
      END IF;
      result_count := jsonb_array_length(records);
      payload := jsonb_build_object('items', CASE WHEN result_count > p_limit THEN records - p_limit ELSE records END,
        'nextCursor', CASE WHEN result_count > p_limit THEN records -> (p_limit - 1) ->> 'id' ELSE NULL END);
      INSERT INTO %1$I.platform_admin_audit(actor_user_id,action,row_count)
        VALUES(p_actor, p_resource || '_read', least(result_count,p_limit));
      RETURN payload;
    END;
    $body$
  $definition$, s);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.platform_admin_read(text,text,text,text,integer,text,text) FROM PUBLIC', s);
END;
$migration$;
COMMIT;
