import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../src/app.mjs';
import { PostgresStore } from '../src/postgres-store.mjs';

test('admin PostgreSQL: real sessions, two APIs, restricted role, no self-promotion, RLS and revocation', {
  skip: !process.env.BAIRUI_TEST_DATABASE_URL,
}, async () => {
  const connectionString = process.env.BAIRUI_TEST_DATABASE_URL;
  const suffix = randomUUID().replaceAll('-', '');
  const schema = 'admin_test_' + suffix;
  const role = 'admin_role_' + suffix;
  const owner = new Pool({ connectionString });
  let elevated;
  let pool;
  const apps = [];
  const env = { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: 'http://localhost:8080',
    BETTER_AUTH_SECRET: 'disposable-admin-integration-secret-32-characters' };
  try {
    await owner.query('CREATE SCHEMA ' + schema);
    await owner.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    elevated = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    const migrations = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await elevated.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    await owner.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ' + schema + ' TO ' + role);
    pool = new Pool({ connectionString, options: '-c search_path=' + schema + ',public -c role=' + role });
    for (let i = 0; i < 2; i++) {
      const app = createApp({ env, store: new PostgresStore({ pool }) });
      await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
      apps.push(app);
    }
    const bases = apps.map(app => 'http://127.0.0.1:' + app.address().port);
    async function register(email) {
      const response = await fetch(bases[0] + '/api/auth/sign-up/email', { method: 'POST',
        headers: { origin: env.BETTER_AUTH_URL, 'content-type': 'application/json' },
        body: JSON.stringify({ email, name: email, password: 'disposable-password-123' }) });
      assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
      const user = (await (await fetch(bases[0] + '/api/auth/me', { headers: { cookie } })).json()).user;
      return { cookie, user };
    }
    const a = await register('admin-candidate@example.test');
    const b = await register('ordinary@example.test');
    const get = (path, account = a, api = 0) => fetch(bases[api] + path, { headers: { cookie: account.cookie } });
    assert.equal((await get('/api/admin/me')).status, 503, 'missing EXECUTE fails closed without breaking client');
    await elevated.query('GRANT EXECUTE ON FUNCTION platform_admin_read(text,text,text,text,integer,text,text) TO ' + role);
    assert.equal((await get('/api/admin/users')).status, 403);
    await assert.rejects(pool.query("INSERT INTO platform_role_bindings(user_id, role, granted_by, reason) VALUES($1, 'platform_admin', 'self', 'forged')", [a.user.userId]), { code: '42501' });
    await elevated.query("INSERT INTO platform_role_bindings(user_id, role, granted_by, reason) VALUES($1, 'platform_viewer', 'test-dba', 'acceptance')", [a.user.userId]);
    assert.equal((await pool.query('SELECT * FROM platform_role_bindings')).rows.length, 0);
    for (const [id, account] of [['agent-a', a], ['agent-b', b]]) {
      await elevated.query("INSERT INTO agents(id,organization_id,owner_user_id,name,status,host,engine) VALUES($1,$2,$3,$1,'stopped',$1 || '.localhost','mock')", [id, account.user.organizationId, account.user.userId]);
      await elevated.query("INSERT INTO runtime_routes(agent_id,organization_id,runtime_url) VALUES($1,$2,'http://private-runtime-never-return')", [id, account.user.organizationId]);
    }
    assert.equal((await get('/api/admin/me', a, 1)).status, 200);
    const users = await (await get('/api/admin/users?limit=1')).json();
    assert.equal(users.items.length, 1);
    assert.ok(users.nextCursor);
    const next = await (await get('/api/admin/users?limit=1&after=' + users.nextCursor, a, 1)).json();
    assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].id, users.items[0].id);
    assert.equal(next.nextCursor, null);
    const agents = await (await get('/api/admin/agents')).json();
    assert.equal(agents.items.length, 2);
    assert.equal(JSON.stringify(agents).includes('runtime'), false);
    assert.equal((await get('/api/admin/agents', b)).status, 403);
    assert.equal((await get('/api/user/agents/agent-b')).status, 404);
    assert.equal((await pool.query('SELECT * FROM agents')).rows.length, 0, 'admin read grant does not disable RLS');
    assert.equal((await pool.query("UPDATE platform_role_bindings SET role='platform_admin'")).rowCount, 0);
    assert.equal((await pool.query('DELETE FROM platform_admin_audit')).rowCount, 0);
    // Function references must not resolve against an application-created temporary table.
    const client = await pool.connect();
    try {
      await client.query("CREATE TEMP TABLE platform_role_bindings (user_id text, role text, revoked_at timestamptz)");
      await client.query("INSERT INTO pg_temp.platform_role_bindings VALUES($1,'platform_admin',NULL)", [b.user.userId]);
      const result = await client.query('SELECT ' + schema + ".platform_admin_read($1,'me') AS result", [b.user.userId]);
      assert.equal(result.rows[0].result, null);
      await client.query('DROP TABLE pg_temp.platform_role_bindings');
    } finally { client.release(); }
    await elevated.query('REVOKE ALL ON TABLE platform_role_bindings, platform_admin_audit FROM ' + role);
    await assert.rejects(pool.query('SELECT * FROM platform_role_bindings'), { code: '42501' });
    await assert.rejects(pool.query('SELECT * FROM platform_admin_audit'), { code: '42501' });
    for (const api of [0, 1]) assert.equal((await get('/api/admin/users', a, api)).status, 200, 'EXECUTE alone is sufficient');
    await elevated.query('UPDATE platform_role_bindings SET revoked_at=now() WHERE user_id=$1', [a.user.userId]);
    for (const api of [0, 1]) assert.equal((await get('/api/admin/agents', a, api)).status, 403);
    const audit = (await elevated.query('SELECT action FROM platform_admin_audit')).rows.map(row => row.action);
    assert.ok(audit.includes('role_changed'));
    assert.ok(audit.includes('users_read'));
    assert.ok(audit.includes('agents_read'));
    await assert.rejects(pool.query('SELECT * FROM platform_admin_audit'), { code: '42501' });
  } finally {
    for (const app of apps) await new Promise(resolve => app.close(resolve));
    await pool?.end();
    await elevated?.end();
    await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await owner.query('DROP ROLE IF EXISTS ' + role);
    await owner.end();
  }
});
