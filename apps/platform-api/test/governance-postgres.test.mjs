import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../src/app.mjs';
import { PostgresStore } from '../src/postgres-store.mjs';

test('governance PostgreSQL: atomic decisions, single-connection pool and two APIs without simulation tables', { skip: !process.env.BAIRUI_TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.BAIRUI_TEST_DATABASE_URL;
  const suffix = randomUUID().replaceAll('-', ''), schema = 'govern_' + suffix, role = 'govern_app_' + suffix;
  const owner = new Pool({ connectionString });
  let elevated, pool;
  const apps = [];
  const env = { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: 'http://localhost:8080', BETTER_AUTH_SECRET: 'disposable-governance-test-secret-at-least-32' };
  const password = 'disposable-governance-password';
  try {
    await owner.query('CREATE SCHEMA ' + schema);
    await owner.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    elevated = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    const migrations = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(n => n.endsWith('.sql') && !n.startsWith('033')).sort()) await elevated.query(await readFile(new URL(name, migrations), 'utf8'));
    await elevated.query(await readFile(new URL('036_account_governance.sql', migrations), 'utf8'));
    await elevated.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
    await elevated.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ' + schema + ' TO ' + role);
    await elevated.query('REVOKE ALL ON platform_account_governance,platform_governance_audit,platform_role_bindings,platform_admin_audit FROM ' + role);
    await elevated.query('GRANT EXECUTE ON FUNCTION platform_admin_read(text,text,text,text,integer,text,text),platform_account_access(text),platform_account_session_allowed(text),platform_governance_accounts(text,text[]),platform_governance_read(text,text,bigint),platform_governance_change(text,text,text,integer,text,uuid) TO ' + role);
    pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 1500, options: '-c search_path=' + schema + ',public -c role=' + role });
    for (let i = 0; i < 2; i++) {
      const app = createApp({ env, store: new PostgresStore({ pool }) });
      await new Promise(r => app.listen(0, '127.0.0.1', r)); apps.push(app);
    }
    const request = (path, cookie = '', body, replica = 0, headers = {}) => fetch('http://127.0.0.1:' + apps[replica].address().port + path,
      { method: body === undefined ? 'GET' : 'POST', headers: { origin: env.BETTER_AUTH_URL, 'content-type': 'application/json', cookie, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookieOf = res => res.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
    async function register(email) {
      const response = await request('/api/auth/sign-up/email', '', { email, name: email, password });
      assert.equal(response.status, 200, await response.clone().text());
      const cookie = cookieOf(response);
      const me = await request('/api/auth/me', cookie);
      assert.equal(me.status, 200, await me.clone().text());
      return { cookie, email, user: (await me.json()).user };
    }
    const a = await register('govern-admin@example.test'), b = await register('govern-user@example.test'), c = await register('govern-second@example.test');
    await elevated.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES($1,'platform_admin','test','test'),($2,'platform_admin','test','test')", [a.user.userId, c.user.userId]);
    const change = (target, status, version, actor = a, extras = {}, replica = 0) => request('/api/admin/users/' + target.user.userId + '/governance', actor.cookie,
      { status, expectedVersion: version, reason: 'acceptance reason', requestId: randomUUID(), ...extras }, replica);
    const history = target => request('/api/admin/users/' + target.user.userId + '/governance', a.cookie);
    await t.test('pause keeps login/history, blocks all business writes, persists and audits once', async () => {
      assert.equal((await request('/api/user/resources', b.cookie, { kind: 'skill', name: 'retained resource' })).status, 201);
      const requestId = randomUUID();
      assert.equal((await change(b, 'suspended', 0, a, { requestId })).status, 200);
      assert.equal((await change(b, 'suspended', 0, a, { requestId }, 1)).status, 200);
      assert.equal((await change(b, 'banned', 0, a, { requestId })).status, 409);
      assert.equal((await change(b, 'banned', 0)).status, 409);
      for (const replica of [0, 1]) {
        const me = await request('/api/auth/me', b.cookie, undefined, replica);
        assert.equal((await me.json()).user.accountStatus, 'suspended');
        assert.equal((await request('/api/user/resources', b.cookie, { kind: 'skill', name: 'blocked' }, replica)).status, 403);
        assert.equal((await (await request('/api/user/resources', b.cookie, undefined, replica)).json()).resources.length, 1);
      }
      assert.equal((await (await history(b)).json()).items.length, 1);
      const freshStore = new PostgresStore({ pool });
      assert.equal((await (await import('../src/admin/governance.mjs')).accountAccess(freshStore, b.user.userId)).status, 'suspended');
      const login = await request('/api/auth/sign-in/email', '', { email: b.email, password });
      assert.equal(login.status, 200);
      assert.equal((await (await request('/api/auth/me', cookieOf(login), undefined, 1)).json()).user.accountStatus, 'suspended');
    });
    await t.test('ban revokes sessions, prevents login; unban does not revive old cookies or open Agent execution', async () => {
      assert.equal((await change(b, 'banned', 1)).status, 200);
      assert.equal((await request('/api/auth/me', b.cookie, undefined, 1)).status, 401);
      const denied = await request('/api/auth/sign-in/email', '', { email: b.email, password });
      assert.equal(denied.status, 403, await denied.clone().text());
      assert.equal(denied.headers.getSetCookie().length, 0);
      assert.equal((await elevated.query('SELECT count(*)::int n FROM ba_session s JOIN users u ON u.auth_subject=\'better-auth:\'||s."userId" WHERE u.id=$1', [b.user.userId])).rows[0].n, 0);
      assert.equal((await change(b, 'active', 2, a, {}, 1)).status, 200);
      assert.equal((await request('/api/auth/me', b.cookie)).status, 401);
      const login = await request('/api/auth/sign-in/email', '', { email: b.email, password }, 1);
      assert.equal(login.status, 200, await login.clone().text()); b.cookie = cookieOf(login);
      assert.equal((await request('/api/user/agents', b.cookie, {})).status, 403);
      assert.equal((await (await request('/api/user/resources', b.cookie)).json()).resources.length, 1);
    });
    await t.test('minimal grants, no direct state/audit mutation, spoofed actor and origin are rejected', async () => {
      for (const table of ['platform_account_governance', 'platform_governance_audit']) await assert.rejects(pool.query('SELECT * FROM ' + table), { code: '42501' });
      assert.equal((await change(a, 'banned', 0)).status, 409);
      assert.equal((await change(a, 'banned', 0, b, { actor: a.user.userId })).status, 403);
      assert.equal((await request('/api/admin/users/' + b.user.userId + '/governance', a.cookie, {}, 0, { origin: 'https://evil.test' })).status, 403);
      await elevated.query('REVOKE EXECUTE ON FUNCTION platform_account_access(text) FROM ' + role);
      assert.equal((await request('/api/user/resources', b.cookie)).status, 503);
      await elevated.query('GRANT EXECUTE ON FUNCTION platform_account_access(text) TO ' + role);
    });
    await t.test('database rollback is atomic; audit failure cannot leave a banned account or revoke sessions', async () => {
      const before = (await history(b)).status; assert.equal(before, 200);
      await elevated.query("ALTER TABLE platform_governance_audit ADD CONSTRAINT acceptance_fail CHECK (reason <> 'force rollback')");
      assert.equal((await change(b, 'banned', 3, a, { reason: 'force rollback' })).status, 503);
      assert.equal((await request('/api/auth/me', b.cookie)).status, 200);
      assert.equal((await (await history(b)).json()).account.status, 'active');
      await elevated.query('ALTER TABLE platform_governance_audit DROP CONSTRAINT acceptance_fail');
    });
    await t.test('session insert waits for ban transaction and cannot survive a committed ban', async () => {
      const client = await elevated.connect();
      let pending;
      try {
        await client.query('BEGIN');
        await client.query('SELECT platform_governance_change($1,$2,$3,$4,$5,$6)', [a.user.userId, b.user.userId, 'banned', 3, 'race guard', randomUUID()]);
        const authId = (await client.query('SELECT substring(auth_subject from 13) id FROM users WHERE id=$1', [b.user.userId])).rows[0].id;
        let settled = false;
        pending = elevated.query('INSERT INTO ba_session(id,token,"userId","expiresAt") VALUES($1,$1,$2,now()+interval \'1 hour\')', [randomUUID(), authId]).then(() => { settled = true; return null; }, error => { settled = true; return error; });
        await new Promise(r => setTimeout(r, 100)); assert.equal(settled, false);
        await client.query('COMMIT');
        assert.equal((await pending)?.message, 'account_banned');
        assert.equal((await request('/api/auth/me', b.cookie)).status, 401);
      } finally { await client.query('ROLLBACK'); client.release(); if (pending) await pending; }
    });
    await t.test('audit pagination is bounded, descending and preserves history across pages', async () => {
      for (let version = 4; version < 31; version++) {
        const result = await pool.query('SELECT platform_governance_change($1,$2,$3,$4,$5,$6) AS result', [a.user.userId, b.user.userId, version % 2 ? 'suspended' : 'active', version, 'pagination test', randomUUID()]);
        assert.equal(result.rows[0].result.account.version, version + 1);
      }
      const first = await (await history(b)).json();
      assert.equal(first.items.length, 25);
      assert.equal(first.account.version, 31);
      const second = await (await request('/api/admin/users/' + b.user.userId + '/governance?after=' + first.nextCursor, a.cookie)).json();
      assert.equal(second.items.length, 6);
      assert.equal(second.nextCursor, null);
      assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 31);
      assert.ok(BigInt(first.items.at(-1).id) > BigInt(second.items[0].id));
    });
    await t.test('concurrent administrators cannot mutually ban the last effective administrator', async () => {
      const results = await Promise.all([change(c, 'banned', 0, a), change(a, 'banned', 0, c, {}, 1)]);
      assert.equal(results.filter(r => r.status === 200).length, 1);
      const activeAdmins = (await elevated.query("SELECT count(*)::int n FROM platform_role_bindings r WHERE role='platform_admin' AND revoked_at IS NULL AND platform_account_access(user_id)->>'status'='active'")).rows[0].n;
      assert.equal(activeAdmins, 1);
    });
  } finally {
    for (const app of apps) await new Promise(r => app.close(r));
    await pool?.end(); await elevated?.end();
    await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await owner.query('DROP ROLE IF EXISTS ' + role); await owner.end();
  }
});
