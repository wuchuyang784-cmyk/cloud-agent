import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';
import { readClientMonitoring } from '../src/monitoring/client-store.mjs';
import { routeLabel } from '../src/observability/labels.mjs';

const now = new Date();
const recent = now.toISOString();
const old = new Date(now.getTime() - 3600000).toISOString();
const users = [
  { id: 'user-a', email: 'a@example.test', organizationId: 'org-a' },
  { id: 'user-b', email: 'b@example.test', organizationId: 'org-a' },
];
const agent = (id, ownerUserId = 'user-a', organizationId = 'org-a') => ({ id, ownerUserId, organizationId,
  name: id, status: 'ready', engine: 'mock', updatedAt: old, runtimeUrl: 'http://private-secret' });
async function fixture(t) {
  const store = new MemoryStore({ seed: { users, agents: [agent('agent-a'), agent('agent-aa'), agent('agent-b', 'user-b'), agent('agent-c', 'user-a', 'org-b')] } });
  const auth = { provider: 'better-auth', async resolve(req) {
    const user = store.findUser(req.headers['x-test-user']);
    return user && { userId: user.id, organizationId: user.organizationId, email: user.email, role: 'platform_admin' };
  } };
  const app = createApp({ store, auth, env: { NODE_ENV: 'test' } });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => app.close(r)));
  const get = (path = '', user = 'user-a', method = 'GET') => fetch('http://127.0.0.1:' + app.address().port + '/api/user/monitoring/agents' + path,
    { method, headers: user ? { 'x-test-user': user, 'x-owner-user-id': 'user-b' } : {} });
  return { store, get };
}

test('client monitoring: owner scope, pagination, search, read-only and no-store', async t => {
  const { get } = await fixture(t);
  const anon = await get('', null);
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get('cache-control'), 'no-store');
  const response = await get('?limit=1');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const page = await response.json();
  assert.deepEqual(page.items.map(x => x.id), ['agent-a']);
  assert.equal(page.nextCursor, 'agent-a');
  assert.equal(JSON.stringify(page).includes('private-secret'), false);
  assert.equal('ownerUserId' in page.items[0], false);
  const next = await (await get('?limit=1&after=' + page.nextCursor)).json();
  assert.deepEqual(next.items.map(x => x.id), ['agent-aa']);
  assert.equal(next.nextCursor, null);
  assert.deepEqual((await (await get('?q=agent-aa')).json()).items.map(x => x.id), ['agent-aa']);
  assert.equal((await (await get('?q=%25')).json()).items.length, 0, 'search treats SQL wildcard literally');
  for (const path of ['/agent-b', '/agent-c', '/missing']) assert.equal((await get(path)).status, 404);
  for (const query of ['ownerUserId=user-b', 'organizationId=org-b', 'limit=0', 'limit=51', 'limit=1.5', 'limit=1&limit=2', 'range=7d', 'after=bad%2Fid']) {
    assert.equal((await get('?' + query)).status, 422, query);
  }
  assert.equal((await get('/agent-a?range=year')).status, 422);
  assert.equal((await get('/agent-a?range=7d&range=30d')).status, 422);
  assert.equal((await get('', 'user-a', 'POST')).status, 405);
});

test('client monitoring: record age is not runtime health and missing samples are null', async t => {
  const { store, get } = await fixture(t);
  let response = await get('/agent-a');
  assert.equal(response.status, 200);
  let data = await response.json();
  assert.equal(data.agent.recordStatus, 'ready');
  assert.equal(data.agent.routeRecord.freshness, 'missing');
  assert.equal(data.live.sampledAt, null);
  assert.equal(data.live.cpuPercent, null);
  assert.equal(data.live.memoryBytes, null);
  assert.equal(data.usage.summary.calls, null);
  assert.equal(data.usage.summary.tokens, null);
  assert.deepEqual(data.usage.series, []);
  store.markAgentReady('agent-a', 'http://private-secret');
  data = await (await get('/agent-a')).json();
  assert.equal(data.agent.routeRecord.freshness, 'recent');
  assert.equal(data.agent.routeRecord.source, 'lifecycle_record');
  assert.equal(data.live.sampledAt, null);
  store.runtimeRoutes.get('agent-a').lastSeenAt = old;
  data = await (await get('/agent-a')).json();
  assert.equal(data.agent.routeRecord.freshness, 'stale');
  assert.equal(data.agent.routeRecord.recordedAt, old);
  assert.equal(JSON.stringify(data).includes('private-secret'), false);
});

test('client monitoring: structured historical usage is per-agent, windowed, not estimated', async t => {
  const { store, get } = await fixture(t);
  const response = await get('/agent-a?range=7d');
  assert.equal(response.status, 200);
  store.addUsage({ organizationId: 'org-a', userId: 'user-a' }, 12, { agentId: 'agent-a' });
  store.addUsage({ organizationId: 'org-a', userId: 'user-a' }, 999, { agentId: 'agent-aa' });
  store.addUsage({ organizationId: 'org-a', userId: 'user-b' }, 888, { agentId: 'agent-b' });
  store.usageEvents.push(
    { organizationId: 'org-a', userId: 'user-a', agentId: 'agent-a', calls: 2, failedCalls: 1, inputTokens: 3, outputTokens: 4, latencyMs: 20, occurredAt: recent, metadata: { secret: 'never-return' } },
    { organizationId: 'org-a', userId: 'user-a', agentId: 'agent-a', calls: 50, outputTokens: 5000, occurredAt: '2000-01-01T00:00:00.000Z' },
    { organizationId: 'org-b', userId: 'user-a', agentId: 'agent-a', calls: 50, outputTokens: 5000, occurredAt: recent },
    { organizationId: 'org-a', userId: 'user-b', agentId: 'agent-a', calls: 50, outputTokens: 5000, occurredAt: recent },
    { organizationId: 'org-a', userId: 'user-a', agentId: 'agent-a', calls: 50, outputTokens: 5000, occurredAt: '2999-01-01T00:00:00.000Z' },
  );
  const data = await (await get('/agent-a?range=7d')).json();
  assert.equal(data.usage.timezone, 'Asia/Shanghai');
  assert.equal(data.usage.source, 'usage_events');
  assert.equal(data.usage.coverage, 'recorded_only');
  assert.equal(data.usage.summary.events, 2);
  assert.equal(data.usage.summary.calls, 3);
  assert.equal(data.usage.summary.failedCalls, 1);
  assert.equal(data.usage.summary.tokens, 19);
  assert.equal(data.usage.summary.avgLatencyMs, 20);
  assert.equal(data.usage.summary.latencySamples, 1);
  assert.equal(data.usage.summary.successRate, null);
  assert.equal(data.usage.series.length, 1);
  assert.equal(JSON.stringify(data).includes('never-return'), false);
});

test('client monitoring: database failures return a safe 503 and a fixed log event', async t => {
  const { store, get } = await fixture(t);
  store.pool = {};
  store.withScope = async () => { throw new Error('postgres://private-password SELECT private-content'); };
  const logs = [];
  t.mock.method(console, 'error', text => logs.push(JSON.parse(text)));
  const response = await get('/agent-a');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!(await response.text()).includes('private'));
  assert.equal(logs[0].event, 'client_monitoring_unavailable');
  assert.ok(!JSON.stringify(logs).includes('private'));
  assert.equal(routeLabel('/api/user/monitoring/agents/secret-id?token=secret'), '/api/user/monitoring/agents/:agentId');
});

test('client monitoring: route age boundaries and future timestamps are explicit', async t => {
  const { store } = await fixture(t);
  const time = new Date('2026-09-19T01:00:00.000Z');
  const scope = { userId: 'user-a', organizationId: 'org-a' };
  for (const [offset, expected] of [[-300000, 'recent'], [-300001, 'stale'], [1, 'invalid']]) {
    store.runtimeRoutes.set('agent-a', { organizationId: 'org-a', lastSeenAt: new Date(+time + offset).toISOString() });
    const data = await readClientMonitoring(store, scope, { agentId: 'agent-a', range: 'today' }, time);
    assert.equal(data.agent.routeRecord.freshness, expected);
    assert.equal(data.live.status, 'not_connected');
  }
});
