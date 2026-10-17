import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresStore } from '../../src/postgres-store.mjs';
import { changeAnnouncement } from '../../src/announcements/store.mjs';

export async function createPublisherFixture() {
  const connectionString = process.env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL;
  if (!connectionString) throw new Error('isolated_announcement_database_required');
  const suffix = randomUUID().replaceAll('-', ''), schema = 'publisher_' + suffix;
  const appRole = 'notice_app_' + suffix, publisherRole = 'notice_pub_' + suffix, password = randomBytes(24).toString('hex');
  const owner = new Pool({ connectionString });
  let elevated, appPool, publisherPool, secondPublisherPool;
  const close = async () => {
    await Promise.all([appPool?.end(), publisherPool?.end(), secondPublisherPool?.end()]);
    await elevated?.end();
    await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await owner.query('DROP ROLE IF EXISTS ' + appRole); await owner.query('DROP ROLE IF EXISTS ' + publisherRole); await owner.end();
  };
  try {
    await owner.query('CREATE SCHEMA ' + schema);
    await owner.query('CREATE ROLE ' + appRole + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    await owner.query('CREATE ROLE ' + publisherRole + " LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD '" + password + "'");
    elevated = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    await elevated.query('ALTER DEFAULT PRIVILEGES IN SCHEMA ' + schema + ' GRANT ALL ON TABLES TO ' + appRole);
    await elevated.query('ALTER DEFAULT PRIVILEGES IN SCHEMA ' + schema + ' GRANT EXECUTE ON FUNCTIONS TO ' + appRole);
    for (const name of ['001_platform_mvp.sql','022_agent_templates.sql','023_auth_sessions.sql','024_worker_rls.sql','025_client_resources.sql',
      '026_conversation_messages.sql','027_client_resource_contents.sql','028_agent_user_features.sql','029_agent_engine_rls.sql','030_agent_engine_mock_default.sql',
      '031_multi_organization_reservations.sql','032_better_auth.sql','034_platform_admin.sql','036_account_governance.sql','037_governance_reason_length.sql',
      '041_platform_announcements.sql','042_announcement_admin_search.sql','043_announcement_default_expiry.sql','044_user_notification_center.sql','045_announcement_publisher.sql']) {
      await elevated.query(await readFile(new URL('../../../../packages/db/migrations/' + name, import.meta.url), 'utf8'));
    }
    await elevated.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + appRole + ',' + publisherRole);
    await elevated.query('GRANT EXECUTE ON FUNCTION platform_announcement_change(text,jsonb),platform_announcement_read(text,jsonb),platform_announcement_user_read(text,text,jsonb),platform_announcement_mark_read(text,text,uuid) TO ' + appRole);
    await elevated.query('GRANT EXECUTE ON FUNCTION platform_announcement_publisher_tick(integer),platform_announcement_publisher_status() TO ' + publisherRole);
    appPool = new Pool({ connectionString, max: 2, options: '-c search_path=' + schema + ',public -c role=' + appRole });
    const publisherURL = new URL(connectionString); publisherURL.username = publisherRole; publisherURL.password = password;
    publisherURL.searchParams.set('options', '-c search_path=' + schema + ',public');
    publisherPool = new Pool({ connectionString: publisherURL.href, max: 2 });
    secondPublisherPool = new Pool({ connectionString: publisherURL.href, max: 2 });
    for (const id of ['admin','second','user']) {
      await elevated.query('INSERT INTO users(id,email) VALUES($1,$2)', [id,id + '@example.test']);
      await elevated.query("INSERT INTO organizations(id,name,kind) VALUES($1,$1,'personal')", ['org-' + id]);
      await elevated.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'org_admin')", ['org-' + id,id]);
    }
    for (const id of ['admin','second']) await elevated.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES($1,'platform_admin','fixture','fixture')", [id]);
    const appStore = new PostgresStore({ pool: appPool });
    const create = async (extra = {}) => (await changeAnnouncement(appStore, 'admin', { action:'create',requestId:randomUUID(),title:'scheduled',body:'body',...extra })).announcement;
    const schedule = async (extra = {}) => {
      const a = await create(extra);
      return (await changeAnnouncement(appStore, 'admin', { action:'schedule',id:a.id,expectedVersion:a.version,requestId:randomUUID(),scheduledAt:new Date(Date.now()+60000).toISOString() })).announcement;
    };
    const due = async (id, expired = false) => elevated.query("UPDATE platform_announcements SET scheduled_at=clock_timestamp()-interval '10 seconds', expires_at=CASE WHEN $2 THEN clock_timestamp()-interval '1 second' ELSE expires_at END WHERE id=$1", [id,expired]);
    return { owner,elevated,appPool,publisherPool,secondPublisherPool,connectionString:publisherURL.href,schema,appRole,publisherRole,appStore,create,schedule,due,close };
  } catch (error) { await close(); throw error; }
}
