import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { createApp } from '../src/app.mjs';
import { PostgresStore } from '../src/postgres-store.mjs';

test('announcement HTTP: real Better Auth, restricted PG, two APIs, audit and conflict fencing', { skip: !process.env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL;
  const suffix = randomUUID().replaceAll('-', ''), schema = 'notice_http_' + suffix, role = 'notice_http_app_' + suffix;
  const owner = new Pool({ connectionString }); let elevated, pool; const apps = [];
  const env = { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: 'http://localhost:8080', BETTER_AUTH_SECRET: 'announcement-test-only-secret-at-least-32-characters' };
  try {
    await owner.query('CREATE SCHEMA ' + schema);
    await owner.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    elevated = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    const directory = new URL('../../../packages/db/migrations/', import.meta.url);
    const names = (await readdir(directory)).filter(name => name.endsWith('.sql') && !['033', '035', '038', '039', '040'].includes(name.slice(0, 3))).sort();
    for (const name of names) await elevated.query(await readFile(new URL(name, directory), 'utf8'));
    await elevated.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
    await elevated.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ' + schema + ' TO ' + role);
    await elevated.query('REVOKE ALL ON platform_role_bindings,platform_admin_audit,platform_account_governance,platform_governance_audit,platform_announcements,platform_announcement_receipts,platform_announcement_requests,platform_announcement_audit,platform_notification_center_requests FROM ' + role);
    await elevated.query('GRANT EXECUTE ON FUNCTION platform_admin_read(text,text,text,text,integer,text,text),platform_account_access(text),platform_account_session_allowed(text),platform_governance_accounts(text,text[]),platform_announcement_change(text,jsonb),platform_announcement_read(text,jsonb),platform_announcement_user_read(text,text,jsonb),platform_notification_center_read(text,text,jsonb),platform_notification_center_mark(text,text,text),platform_notification_center_all(text,text,uuid) TO ' + role);
    pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 3000, options: '-c search_path=' + schema + ',public -c role=' + role });
    for (let n = 0; n < 2; n++) { const app = createApp({ env, store: new PostgresStore({ pool }) }); await new Promise(r => app.listen(0, '127.0.0.1', r)); apps.push(app); }
    const request = (path, cookie = '', body, { replica = 0, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch('http://127.0.0.1:' + apps[replica].address().port + path,
      { method, headers: { origin: env.BETTER_AUTH_URL, 'content-type': 'application/json', cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    async function register(email) {
      const response = await request('/api/auth/sign-up/email', '', { email, name: email.split('@')[0], password: 'disposable-announcement-test-password' });
      assert.equal(response.status, 200, await response.clone().text());
      const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const identity = await request('/api/auth/me', cookie); assert.equal(identity.status, 200);
      return { cookie, userId: (await identity.json()).user.userId };
    }
    const admin = await register('announcement-admin@example.test'), viewer = await register('announcement-viewer@example.test'), user = await register('announcement-user@example.test');
    await elevated.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES($1,'platform_admin','test','test'),($2,'platform_viewer','test','test')", [admin.userId, viewer.userId]);
    const createInput = { title: '真实会话公告', body: '真实受限应用数据库', requestId: randomUUID(), expiresAt: null };
    let item;
    await t.test('two API replicas replay create and permission projection rejects ordinary users', async () => {
      const results = await Promise.all([0, 1].map(replica => request('/api/admin/announcements', admin.cookie, createInput, { replica })));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
      const records = await Promise.all(results.map(r => r.json())); item = records[0].announcement;
      assert.equal(records[1].announcement.id, item.id);
      const me = await (await request('/api/admin/me', viewer.cookie)).json();
      assert.ok(me.permissions.includes('announcements:read')); assert.equal(me.permissions.includes('announcements:manage'), false);
      assert.equal((await request('/api/admin/announcements', viewer.cookie)).status, 200);
      assert.equal((await request('/api/admin/announcements', viewer.cookie, createInput)).status, 403);
      assert.equal((await request('/api/admin/announcements', user.cookie)).status, 403);
      await assert.rejects(pool.query('SELECT * FROM platform_announcements'), { code: '42501' });
    });
    await t.test('search is server-side, expiry resets atomically and stale edit cannot overwrite publication', async () => {
      const edit = { title: item.title, body: item.body, expiryDays: 30, requestId: randomUUID(), expectedVersion: 1 };
      const revised = await request('/api/admin/announcements/' + item.id, admin.cookie, edit, { method: 'PATCH' });
      assert.equal(revised.status, 200); assert.equal((await revised.json()).announcement.expiryDays, 30);
      const publish = { requestId: randomUUID(), expectedVersion: 2 };
      const results = await Promise.all([0, 1].map(replica => request('/api/admin/announcements/' + item.id + '/publish', admin.cookie, publish, { replica })));
      assert.ok(results.every(r => r.status === 200));
      assert.equal((await request('/api/admin/announcements/' + item.id, admin.cookie, edit, { method: 'PATCH' })).status, 200, 'exact edit replay returns original result');
      assert.equal((await request('/api/admin/announcements/' + item.id, admin.cookie, { ...edit, requestId: randomUUID() }, { method: 'PATCH' })).status, 409);
      const list = await (await request('/api/admin/announcements?q=' + encodeURIComponent('真实会话') + '&status=published', admin.cookie)).json();
      assert.equal(list.items.length, 1); assert.equal('body' in list.items[0], false);
      const audit = await (await request('/api/admin/announcements/' + item.id + '/audit', admin.cookie)).json();
      assert.deepEqual(audit.items.map(row => row.action), ['published', 'draft_updated', 'created']);
    });
    await t.test('personal center uses real sessions across replicas and persists all-read request snapshots', async () => {
      const insert = async (id, title) => elevated.query("INSERT INTO user_notifications(id,organization_id,user_id,title,body) SELECT $1,organization_id,user_id,$3,'body' FROM organization_members WHERE user_id=$2", [id, user.userId, title]);
      await insert('http-own', '本人通知');
      const list = await request('/api/user/notifications?source=announcement', user.cookie); assert.equal(list.status, 200);
      assert.equal((await list.json()).unreadCount, 2);
      const detail = await request('/api/user/announcements/' + item.id, user.cookie, undefined, { replica: 1 });
      assert.equal(detail.status, 200); assert.equal((await detail.json()).unreadCount, 2);
      const unauthorized = await request('/api/user/notifications', ''); assert.equal(unauthorized.status, 401);
      const requestId = randomUUID();
      const results = await Promise.all([0, 1].map(replica => request('/api/user/notifications/read-all', user.cookie, { requestId }, { replica })));
      assert.ok(results.every(r => r.status === 200)); const values = await Promise.all(results.map(r => r.json()));
      assert.equal(values.filter(x => x.replayed).length, 1); assert.ok(values.every(x => x.updated === 2 && x.unreadCount === 0));
      await insert('http-new', '后来通知');
      const replay = await (await request('/api/user/notifications/read-all', user.cookie, { requestId }, { replica: 1 })).json();
      assert.equal(replay.replayed, true); assert.equal(replay.unreadCount, 1);
      assert.equal((await request('/api/user/notifications/http-new', viewer.cookie, { read: true }, { method: 'PATCH' })).status, 404);
      assert.equal((await request('/api/user/notifications/http-new', user.cookie, { read: true }, { method: 'PATCH' })).status, 200);
      assert.equal((await request('/api/user/notifications/http-new', user.cookie, { read: true }, { method: 'PATCH', replica: 1 })).status, 200);
      assert.equal((await (await request('/api/user/announcements/' + item.id, viewer.cookie)).json()).announcement.isRead, false);
      await assert.rejects(pool.query('SELECT * FROM platform_notification_center_requests'), { code: '42501' });
      await elevated.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES($1,'suspended',1)", [user.userId]);
      assert.equal((await request('/api/user/notifications', user.cookie)).status, 200);
      assert.equal((await request('/api/user/notifications/read-all', user.cookie, { requestId: randomUUID() })).status, 403);
      await elevated.query("UPDATE platform_account_governance SET status='active',version=version+1 WHERE user_id=$1", [user.userId]);
    });
    await t.test('missing announcement grants isolate outage from users list; role revocation blocks next write', async () => {
      await elevated.query('REVOKE EXECUTE ON FUNCTION platform_announcement_read(text,jsonb) FROM ' + role);
      const unavailable = await request('/api/admin/announcements', admin.cookie);
      assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error.code, 'announcements_unavailable');
      assert.equal((await request('/api/admin/users', admin.cookie)).status, 200);
      await elevated.query('GRANT EXECUTE ON FUNCTION platform_announcement_read(text,jsonb) TO ' + role);
      await elevated.query('UPDATE platform_role_bindings SET revoked_at=now() WHERE user_id=$1', [admin.userId]);
      assert.equal((await request('/api/admin/announcements/' + item.id + '/withdraw', admin.cookie, { expectedVersion: 3, requestId: randomUUID(), reason: 'x' }, { replica: 1 })).status, 403);
      assert.equal((await elevated.query("SELECT count(*)::int n FROM platform_announcement_audit WHERE action='withdrawn'")).rows[0].n, 0);
    });
  } finally {
    for (const app of apps) await new Promise(r => app.close(r));
    await pool?.end(); await elevated?.end(); await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await owner.query('DROP ROLE IF EXISTS ' + role); await owner.end();
  }
});
