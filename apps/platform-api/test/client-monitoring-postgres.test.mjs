import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../src/app.mjs';
import { PostgresStore } from '../src/postgres-store.mjs';
import { MemoryStore } from '../src/store.mjs';
import { readClientMonitoring, monitoringWindow } from '../src/monitoring/client-store.mjs';

test('client monitoring PostgreSQL: restricted role, dual APIs, scoped aggregates, RLS and Memory parity', {
  skip: !process.env.BAIRUI_TEST_DATABASE_URL,
}, async () => {
  const connectionString = process.env.BAIRUI_TEST_DATABASE_URL;
  const suffix = randomUUID().replaceAll('-', '');
  const schema = 'monitor_test_' + suffix;
  const role = 'monitor_role_' + suffix;
  const owner = new Pool({ connectionString });
  let elevated, pool;
  const apps = [];
  try {
    await owner.query('CREATE SCHEMA ' + schema);
    await owner.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    elevated = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    const migrations = new URL('../../../packages/db/migrations/', import.meta.url);
    // B must work on the existing client schema without the separate admin migration.
    for (const file of (await readdir(migrations)).filter(x => /^\d{3}_.+\.sql$/.test(x) && Number(x.slice(0, 3)) <= 33).sort()) {
      await elevated.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    assert.equal((await elevated.query('SELECT to_regclass($1) AS relation', [schema + '.platform_role_bindings'])).rows[0].relation, null);
    await owner.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
    await owner.query('GRANT SELECT ON ALL TABLES IN SCHEMA ' + schema + ' TO ' + role);
    pool = new Pool({ connectionString, max: 1, options: '-c search_path=' + schema + ',public -c role=' + role });
    const store = new PostgresStore({ pool });
    await elevated.query("INSERT INTO organizations(id,name) VALUES('org-a','A'),('org-b','B')");
    await elevated.query("INSERT INTO users(id,email) VALUES('user-a','a@example.test'),('user-b','b@example.test')");
    const scope = { userId: 'user-a', organizationId: 'org-a' };
    const now = new Date('2026-09-19T01:00:00.000Z');
    const memory = new MemoryStore();
    for (const [id, org, user] of [['agent-a', 'org-a', 'user-a'], ['agent-aa', 'org-a', 'user-a'], ['agent-b', 'org-a', 'user-b'], ['agent-c', 'org-b', 'user-a']]) {
      await elevated.query("INSERT INTO agents(id,organization_id,owner_user_id,name,status,host,engine,updated_at) VALUES($1,$2,$3,$1,'ready',$1 || '.localhost','mock',$4)", [id, org, user, now]);
      memory.agents.set(id, { id, organizationId: org, ownerUserId: user, name: id, status: 'ready', engine: 'mock', updatedAt: now.toISOString() });
    }
    await elevated.query("INSERT INTO runtime_routes(agent_id,organization_id,runtime_url,health_status,last_seen_at) VALUES('agent-a','org-a','http://secret-route','healthy',$1)", [now]);
    memory.runtimeRoutes.set('agent-a', { agentId: 'agent-a', organizationId: 'org-a', healthStatus: 'healthy', lastSeenAt: now.toISOString() });
    const times = ['2026-09-18T15:59:59.999Z', '2026-09-18T16:00:00.000Z', '2026-09-19T00:30:00.000Z', '2026-09-19T02:00:00.000Z', '2026-08-01T00:00:00.000Z'];
    for (const time of times) {
      await elevated.query("INSERT INTO usage_events(organization_id,user_id,agent_id,calls,failed_calls,input_tokens,output_tokens,latency_ms,occurred_at,metadata) VALUES('org-a','user-a','agent-a',2,1,3,7,20,$1,'{\"secret\":\"private-content\"}')", [time]);
      memory.usageEvents.push({ ...scope, agentId: 'agent-a', calls: 2, failedCalls: 1, inputTokens: 3, outputTokens: 7, latencyMs: 20, occurredAt: time });
    }
    // Even malformed legacy attribution must not enter another owner or organization's totals.
    for (const [org, user, id] of [['org-a', 'user-b', 'agent-a'], ['org-b', 'user-a', 'agent-a'], ['org-a', 'user-a', 'agent-aa']]) {
      await elevated.query('INSERT INTO usage_events(organization_id,user_id,agent_id,output_tokens,occurred_at) VALUES($1,$2,$3,9999,$4)', [org, user, id, now]);
      memory.usageEvents.push({ organizationId: org, userId: user, agentId: id, outputTokens: 9999, occurredAt: now.toISOString() });
    }
    for (const range of ['today', '7d', '30d']) {
      const actual = await readClientMonitoring(store, scope, { agentId: 'agent-a', range }, now);
      assert.deepEqual(actual, await readClientMonitoring(memory, scope, { agentId: 'agent-a', range }, now));
      assert.equal(actual.usage.summary.calls, range === 'today' ? 4 : 6);
      assert.equal(actual.usage.summary.tokens, range === 'today' ? 20 : 30);
      assert.ok(!JSON.stringify(actual).includes('private-content'));
      assert.ok(!JSON.stringify(actual).includes('secret-route'));
    }
    assert.deepEqual(await readClientMonitoring(store, scope, { limit: 1 }, now), await readClientMonitoring(memory, scope, { limit: 1 }, now));
    assert.equal((await readClientMonitoring(store, scope, { limit: 20, q: '%' }, now)).items.length, 0);
    const missing = await readClientMonitoring(store, scope, { agentId: 'agent-aa', range: 'today' }, now);
    assert.equal(missing.agent.routeRecord.freshness, 'missing');
    assert.equal(missing.usage.summary.avgLatencyMs, null);
    for (const table of ['agents', 'runtime_routes', 'usage_events']) {
      assert.equal((await pool.query('SELECT * FROM ' + table)).rowCount, 0, 'scope resets when pooled connection is released');
    }
    const noScope = await pool.query("SELECT current_setting('app.user_id', true) AS scope, current_setting('statement_timeout') AS timeout");
    assert.equal(noScope.rows[0].scope, '');
    assert.equal(noScope.rows[0].timeout, '0');
    const auth = { provider: 'better-auth', async resolve(req) {
      return ['user-a', 'user-b'].includes(req.headers['x-test-user']) ? { userId: req.headers['x-test-user'], organizationId: 'org-a' } : null;
    } };
    for (let i = 0; i < 2; i++) {
      const app = createApp({ store, auth, env: { NODE_ENV: 'test' } });
      await new Promise(r => app.listen(0, '127.0.0.1', r)); apps.push(app);
    }
    await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const user = i % 2 ? 'user-a' : 'user-b';
      const base = 'http://127.0.0.1:' + apps[i % 2].address().port + '/api/user/monitoring/agents';
      const response = await fetch(base, { headers: { 'x-test-user': user } });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.items.map(x => x.id), user === 'user-a' ? ['agent-a', 'agent-aa'] : ['agent-b']);
      const foreign = await fetch(base + (user === 'user-a' ? '/agent-b' : '/agent-a'), { headers: { 'x-test-user': user } });
      assert.equal(foreign.status, 404);
    }));
  } finally {
    for (const app of apps) await new Promise(r => app.close(r));
    await pool?.end(); await elevated?.end();
    await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await owner.query('DROP ROLE IF EXISTS ' + role); await owner.end();
  }
});

test('monitoring windows: Shanghai calendar boundaries including leap day', () => {
  assert.equal(monitoringWindow('today', new Date('2026-09-18T16:00:00.000Z')).from, '2026-09-18T16:00:00.000Z');
  assert.equal(monitoringWindow('7d', new Date('2026-09-19T01:00:00.000Z')).from, '2026-09-12T16:00:00.000Z');
  assert.equal(monitoringWindow('today', new Date('2024-02-29T00:00:00.000Z')).from, '2024-02-28T16:00:00.000Z');
});
