import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresStore } from '../src/postgres-store.mjs';
import { notificationCenterContract } from './helpers/notification-center-contract.mjs';
import * as api from '../src/announcements/notifications.mjs';

test('notification center restricted PostgreSQL contract, atomicity and privileges', { skip: !process.env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL;
  const suffix = randomUUID().replaceAll('-', ''), schema = 'center_' + suffix, role = 'center_app_' + suffix;
  const owner = new Pool({ connectionString }); let elevated, pool, secondPool;
  try {
    await owner.query('CREATE SCHEMA ' + schema); await owner.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    elevated = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    await elevated.query('ALTER DEFAULT PRIVILEGES IN SCHEMA ' + schema + ' GRANT ALL ON TABLES TO ' + role);
    await elevated.query('ALTER DEFAULT PRIVILEGES IN SCHEMA ' + schema + ' GRANT EXECUTE ON FUNCTIONS TO ' + role);
    const directory = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql') && !['033', '035', '038', '039', '040'].includes(n.slice(0, 3))).sort()) await elevated.query(await readFile(new URL(name, directory), 'utf8'));
    await elevated.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
    const signatures = ['platform_announcement_change(text,jsonb)', 'platform_notification_center_read(text,text,jsonb)', 'platform_notification_center_mark(text,text,text)', 'platform_notification_center_all(text,text,uuid)'];
    await elevated.query('GRANT EXECUTE ON FUNCTION ' + signatures.join(',') + ' TO ' + role);
    const config = { connectionString, max: 2, options: '-c search_path=' + schema + ',public -c role=' + role + ' -c TimeZone=America/New_York' };
    pool = new Pool(config); secondPool = new Pool(config);
    const store = new PostgresStore({ pool }), secondStore = new PostgresStore({ pool: secondPool });
    for (const id of ['admin', 'user', 'other']) {
      await elevated.query('INSERT INTO users(id,email) VALUES($1,$2)', [id, id + '@example.test']);
      await elevated.query("INSERT INTO organizations(id,name,kind) VALUES($1,$1,'personal')", ['org-' + id]);
      await elevated.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'org_admin')", ['org-' + id, id]);
    }
    await elevated.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES('admin','platform_admin','fixture','fixture')");
    const scope = { userId: 'user', organizationId: 'org-user' };
    await notificationCenterContract(t, { store, secondStore, scope, otherScope: { userId: 'other', organizationId: 'org-other' },
      async expire(id) { await elevated.query("UPDATE platform_announcements SET published_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]); },
      async govern(id, status) { await elevated.query('INSERT INTO platform_account_governance(user_id,status,version) VALUES($1,$2,1) ON CONFLICT(user_id) DO UPDATE SET status=$2,version=platform_account_governance.version+1', [id, status]); },
    }, api);
    await t.test('cursor retains microseconds across page boundaries', async () => {
      await elevated.query("INSERT INTO user_notifications(id,organization_id,user_id,type,title,body,created_at) VALUES('precision-a','org-user','user','system','a','','2026-01-01T00:00:00.123456Z'),('precision-b','org-user','user','system','b','','2026-01-01T00:00:00.123455Z')");
      let after, ids = [];
      do { const page = await api.readNotificationCenter(store, scope, { source: 'notification', limit: 1, ...(after ? { after } : {}) }); ids.push(...page.notifications.map(n => n.id)); after = page.nextCursor; } while (after);
      assert.equal(ids.filter(id => id.startsWith('precision-')).length, 2);
      assert.ok(ids.indexOf('precision-a') < ids.indexOf('precision-b'));
    });
    await t.test('failed request record insertion rolls back both sources and permits exact retry', async () => {
      const requestId = randomUUID(), before = await api.readNotificationCenter(store, scope, { read: 'unread' });
      assert.ok(before.unreadCount > 0);
      await elevated.query('ALTER TABLE platform_notification_center_requests ADD CONSTRAINT reject_request CHECK (false) NOT VALID');
      await assert.rejects(api.markNotificationCenterRead(store, scope, requestId), { code: 'announcements_unavailable' });
      assert.equal((await api.readNotificationCenter(store, scope)).unreadCount, before.unreadCount);
      await elevated.query('ALTER TABLE platform_notification_center_requests DROP CONSTRAINT reject_request');
      assert.equal((await api.markNotificationCenterRead(store, scope, requestId)).replayed, false);
    });
    await t.test('SQL independently validates all query shapes and keeps private tables/function helpers closed', async () => {
      for (const q of [null, [], { limit: '2' }, { history: null }, { source: null }, { cursor: {} }, { cursor: { pinned: false, createdAt: 'bad', source: 'notification', referenceId: 'x' } }, { userId: 'other' }]) await assert.rejects(pool.query('SELECT platform_notification_center_read($1,$2,$3)', ['user', 'org-user', JSON.stringify(q)]), { code: '22023' }, JSON.stringify(q));
      await assert.rejects(pool.query('SELECT * FROM platform_notification_center_requests'), { code: '42501' });
      await assert.rejects(pool.query('TRUNCATE platform_notification_center_requests'), { code: '42501' });
      await assert.rejects(pool.query('SELECT platform_notification_center_rows($1,$2,now())', ['user', 'org-user']), { code: '42501' });
      assert.deepEqual((await elevated.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='platform_notification_center_requests'::regclass")).rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    });
    await t.test('migration reapply preserves function OIDs, grants, receipts and request data', async () => {
      const snapshot = async () => ({ functions: (await elevated.query("SELECT oid,proacl::text FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname LIKE 'platform_notification_center_%' ORDER BY oid", [schema])).rows,
        requests: (await elevated.query('SELECT * FROM platform_notification_center_requests ORDER BY organization_id,user_id,request_id')).rows });
      const before = await snapshot();
      await elevated.query('GRANT ALL ON platform_notification_center_requests TO ' + role);
      await elevated.query(await readFile(new URL('044_user_notification_center.sql', directory), 'utf8'));
      assert.deepEqual(await snapshot(), before);
      await assert.rejects(pool.query('SELECT * FROM platform_notification_center_requests'), { code: '42501' });
    });
    await t.test('read-all waits on governance lock before checking suspended status', async () => {
      const c = await elevated.connect(); let pending;
      try {
        await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [schema + ':governance:changes']);
        await c.query("UPDATE platform_account_governance SET status='suspended',version=version+1 WHERE user_id='user'");
        let settled = false; pending = api.markNotificationCenterRead(store, scope, randomUUID()).then(result => { settled = true; return result; });
        await new Promise(r => setTimeout(r, 100)); assert.equal(settled, false);
        await c.query('COMMIT'); assert.equal((await pending).error, 'account_read_only');
      } finally { await c.query('ROLLBACK'); c.release(); await pending; }
    });
    await t.test('real governance mutation waits for in-flight read-all before changing account status', async () => {
      await elevated.query("UPDATE platform_account_governance SET status='active',version=version+1 WHERE user_id='user'");
      const c = await elevated.connect(); let pending;
      try {
        await c.query('BEGIN');
        const result = await c.query('SELECT platform_notification_center_all($1,$2,$3) result', ['user', 'org-user', randomUUID()]);
        assert.equal(result.rows[0].result.ok, true);
        const version = Number((await elevated.query("SELECT platform_account_access('user')->>'version' v")).rows[0].v);
        let settled = false;
        pending = elevated.query('SELECT platform_governance_change($1,$2,$3,$4,$5,$6) result', ['admin', 'user', 'suspended', version, 'notification center fence', randomUUID()]).then(result => { settled = true; return result; });
        await new Promise(r => setTimeout(r, 100)); assert.equal(settled, false);
        await c.query('COMMIT'); assert.equal((await pending).rows[0].result.account.status, 'suspended');
      } finally { await c.query('ROLLBACK'); c.release(); await pending; }
    });
  } finally {
    await pool?.end(); await secondPool?.end(); await elevated?.end();
    await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await owner.query('DROP ROLE IF EXISTS ' + role); await owner.end();
  }
});
