import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { getSchema } from 'better-auth/db';
import { createApp } from '../src/app.mjs';
import { PostgresStore } from '../src/postgres-store.mjs';
import { betterAuthOptions } from '../src/auth/better-auth-resolver.mjs';

// Only point this at a disposable test database with schema/role creation permission.
test('PostgreSQL: migrations, two API replicas, concurrent identity mapping and tenant isolation', {
  skip: !process.env.BAIRUI_TEST_DATABASE_URL,
}, async () => {
  const connectionString = process.env.BAIRUI_TEST_DATABASE_URL;
  const admin = new Pool({ connectionString });
  const suffix = randomUUID().replaceAll('-', '');
  const schema = 'auth_test_' + suffix;
  const role = 'auth_role_' + suffix;
  const apps = [];
  let pool;
  const env = { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: 'http://localhost:8080', BETTER_AUTH_SECRET: 'integration-test-only-secret-32-characters', BAIRUI_TRUSTED_PROXIES: '127.0.0.1/32' };
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    await admin.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    pool = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    const migrations = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    await admin.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
    await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ' + schema + ' TO ' + role);
    await pool.end();
    pool = new Pool({ connectionString, options: '-c search_path=' + schema + ',public -c role=' + role });
    const privilege = (await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    assert.equal(privilege.rolsuper, false);
    assert.equal(privilege.rolbypassrls, false);
    for (const [table, definition] of Object.entries(getSchema(betterAuthOptions(env, pool)))) {
      const columns = (await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [schema, table])).rows.map(row => row.column_name);
      for (const field of ['id', ...Object.keys(definition.fields)]) assert.ok(columns.includes(field), table + '.' + field);
    }
    for (let i = 0; i < 2; i++) {
      const app = createApp({ env, store: new PostgresStore({ pool }) });
      await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
      apps.push(app);
    }
    const bases = apps.map(app => 'http://127.0.0.1:' + app.address().port);
    async function signup(email) {
      const response = await fetch(bases[0] + '/api/auth/sign-up/email', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: env.BETTER_AUTH_URL },
        body: JSON.stringify({ email, name: email, password: 'integration-password-123' }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    }
    const cookie = await signup('one@example.test');
    const results = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const response = await fetch(bases[i % 2] + '/api/auth/me', { headers: { cookie } });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).user;
    }));
    assert.equal(new Set(results.map(user => user.userId)).size, 1);
    assert.equal((await pool.query('SELECT count(*) FROM organizations')).rows[0].count, '1');
    const cookieTwo = await signup('two@example.test');
    const userTwo = (await (await fetch(bases[1] + '/api/auth/me', { headers: { cookie: cookieTwo } })).json()).user;
    assert.notEqual(userTwo.organizationId, results[0].organizationId);
    const created = await fetch(bases[0] + '/api/user/resources', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'skill', name: 'private skill' }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const resource = (await created.json()).resource;
    assert.equal((await fetch(bases[1] + '/api/user/resources/' + resource.id, { headers: { cookie: cookieTwo } })).status, 404);
    // Query via the admin connection so RLS cannot conceal an unexpected write.
    const tables = ['agents', 'sessions_projection', 'conversation_messages', 'usage_events', 'control_outbox', 'idempotency_keys', 'user_accounts', 'account_transactions'];
    const counts = async () => Promise.all(tables.map(async table => (await admin.query('SELECT count(*) FROM ' + schema + '.' + table)).rows[0].count));
    const before = await counts();
    for (const path of ['/api/user/agents', '/api/user/agents/historic/start', '/api/user/agents/historic/stop', '/api/user/agents/historic/sessions', '/api/user/agents/historic/sessions/old/chat/stream', '/api/user/billing/recharge']) {
      const response = await fetch(bases[1] + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{invalid-json' });
      assert.equal(response.status, 403, path);
      assert.equal((await response.json()).error.code, 'capability_disabled');
    }
    assert.deepEqual(await counts(), before);
    assert.equal(apps[0].platform.runtime, null);

    async function signIn(base, origin, forwarded, index = 0, password = 'wrong-password-12345') {
      const response = await fetch(base + '/api/auth/sign-in/email', {
        method: 'POST', headers: { origin, 'content-type': 'application/json',
          'x-forwarded-for': forwarded, 'x-real-ip': '203.0.113.' + (index + 1),
          'x-bairui-peer-ip': '203.0.113.' + (index + 1), forwarded: 'for=203.0.113.' + (index + 1) },
        body: JSON.stringify({ email: 'two@example.test', password }),
      });
      await response.arrayBuffer();
      return response;
    }
    const burst = await Promise.all(Array.from({ length: 16 }, (_, i) => signIn(bases[i % 2], env.BETTER_AUTH_URL, '203.0.113.' + (i + 1) + ', 198.51.100.20', i)));
    assert.equal(burst.filter(r => r.status === 401).length, 3, 'two APIs must admit exactly three attempts, not three per API');
    assert.equal(burst.filter(r => r.status === 429).length, 13);
    for (const r of burst.filter(r => r.status === 429)) assert.ok(Number(r.headers.get('retry-after')) > 0 && Number(r.headers.get('retry-after')) <= 10, 'Retry-After=' + r.headers.get('retry-after'));
    for (const ip of ['198.51.100.21', '198.51.100.22']) assert.equal((await signIn(bases[1], env.BETTER_AUTH_URL, ip)).status, 401, 'different client is not throttled by another client');
    assert.equal((await signIn(bases[0], env.BETTER_AUTH_URL, 'invalid-forwarded-ip')).status, 400);
    const retry = Math.max(...burst.filter(r => r.status === 429).map(r => Number(r.headers.get('retry-after'))));
    await new Promise(resolve => setTimeout(resolve, retry * 1000 + 200));
    assert.equal((await signIn(bases[1], env.BETTER_AUTH_URL, '198.51.100.20')).status, 401, 'Retry-After expiry reopens the window');

    const direct = createApp({ env: { ...env, BAIRUI_TRUSTED_PROXIES: '' }, store: new PostgresStore({ pool }) });
    await new Promise(resolve => direct.listen(0, '127.0.0.1', resolve));
    apps.push(direct);
    const directBase = 'http://127.0.0.1:' + direct.address().port;
    const forged = await Promise.all(Array.from({ length: 12 }, (_, i) => signIn(directBase, env.BETTER_AUTH_URL, '192.0.2.' + (i + 1), i)));
    assert.equal(forged.filter(r => r.status === 401).length, 3);
    assert.equal(forged.filter(r => r.status === 429).length, 9, 'untrusted client cannot reset its bucket with forwarding headers');

    const productionOrigin = 'https://production.example.test';
    const production = createApp({ env: { ...env, DATABASE_URL: connectionString, NODE_ENV: 'production', BETTER_AUTH_URL: productionOrigin,
      BAIRUI_SIMULATION_ENABLED: '1', BAIRUI_SIMULATION_USERS: 'two@example.test' }, store: new PostgresStore({ pool }) });
    await new Promise(resolve => production.listen(0, '127.0.0.1', resolve));
    apps.push(production);
    const productionBase = 'http://127.0.0.1:' + production.address().port;
    const productionLogin = await signIn(productionBase, productionOrigin, '198.51.100.30', 0, 'integration-password-123');
    assert.equal(productionLogin.status, 200);
    const productionCookie = productionLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.equal((await fetch(productionBase + '/api/auth/me', { headers: { cookie: productionCookie } })).status, 200);
    assert.equal((await fetch(productionBase + '/api/simulation/tasks', { headers: { cookie: productionCookie } })).status, 404, 'simulation remains disabled in production with valid auth');

    const logout = await fetch(bases[1] + '/api/auth/sign-out', {
      method: 'POST', headers: { cookie, origin: env.BETTER_AUTH_URL, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(bases[0] + '/api/auth/me', { headers: { cookie } })).status, 401);
  } finally {
    for (const app of apps) await new Promise(resolve => app.close(resolve));
    await pool?.end();
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin.query('DROP ROLE IF EXISTS ' + role);
    await admin.end();
  }
});
