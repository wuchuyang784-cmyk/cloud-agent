import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';
import { createAdminMonitoring } from '../src/admin/monitoring.mjs';

const seed = { users: [
  { id: 'admin-a', email: 'admin@example.test', organizationId: 'org-a', role: 'user' },
  { id: 'ordinary', email: 'ordinary@example.test', organizationId: 'org-b', role: 'user' },
] };

async function fixture(t, adminMonitoring) {
  const store = new MemoryStore({ seed });
  store.platformRoles = new Map([['admin-a', { role: 'platform_viewer', revokedAt: null }]]);
  const auth = { provider: 'better-auth', async resolve(req) {
    const user = store.findUser(req.headers['x-test-user']);
    return user && { userId: user.id, organizationId: user.organizationId, email: user.email };
  } };
  const app = createApp({ store, auth, adminMonitoring, env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth' } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  return { store, request: (path, user = 'admin-a', init = {}) => fetch('http://127.0.0.1:' + app.address().port + path,
    { ...init, headers: { ...(user ? { 'x-test-user': user } : {}), ...init.headers } }) };
}

test('admin monitoring: fixed overview and bounded alert projections are authorized', async t => {
  const monitoring = { enabled: true, async overview() { return { status: 'fresh', sampledAt: '2026-10-07T00:00:00.000Z', metrics: {} }; },
    async alerts(filter) { return { items: [{ name: 'ApiDown', severity: filter.severity || 'critical', state: filter.state || 'firing', activeAt: null, instance: null }] }; } };
  const { request } = await fixture(t, monitoring);
  assert.equal((await request('/api/admin/monitoring/overview', null)).status, 401);
  assert.equal((await request('/api/admin/monitoring/overview', 'ordinary')).status, 403);
  const overview = await request('/api/admin/monitoring/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.headers.get('cache-control'), 'no-store');
  assert.equal((await overview.json()).status, 'fresh');
  const alerts = await request('/api/admin/monitoring/alerts?severity=critical&state=firing');
  assert.equal(alerts.status, 200);
  assert.equal((await alerts.json()).items[0].name, 'ApiDown');
  for (const query of ['severity=unknown', 'state=resolved', 'query=up', 'severity=info&severity=critical']) {
    assert.equal((await request('/api/admin/monitoring/alerts?' + query)).status, 422, query);
  }
});
test('admin monitoring: disabled and upstream failures fail closed without details', async t => {
  const { request } = await fixture(t, { enabled: false });
  const disabled = await request('/api/admin/monitoring/overview');
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).error.code, 'monitoring_unavailable');
});

test('admin monitoring client uses only fixed PromQL, bounds bytes and projects alerts', async () => {
  const seen = [];
  const fetchImpl = async url => {
    seen.push(url.toString());
    const isAlerts = url.pathname.endsWith('/alerts');
    const isFreshness = url.searchParams.get('query')?.includes('timestamp(');
    return new Response(JSON.stringify(isAlerts
      ? { status: 'success', data: { alerts: [{ labels: { alertname: 'ApiDown', severity: 'critical', instance: 'api-1' }, state: 'firing', activeAt: '2026-10-07T00:00:00Z', annotations: { secret: 'hidden' } }] } }
      : { status: 'success', data: { result: [{ value: [Date.now() / 1000, String(isFreshness ? Date.now() / 1000 : 2)] }] } }));
  };
  const client = createAdminMonitoring({ baseUrl: 'http://prometheus:9090', fetchImpl });
  const overview = await client.overview();
  assert.equal(overview.metrics.apiReplicas.value, 2);
  assert.equal(seen.length, 12);
  assert.ok(seen.every(url => url.startsWith('http://prometheus:9090/api/v1/query?query=')));
  const alerts = await client.alerts({ severity: 'critical', state: 'firing' });
  assert.deepEqual(Object.keys(alerts.items[0]), ['name', 'severity', 'state', 'activeAt', 'instance']);
  const oversized = createAdminMonitoring({ baseUrl: 'http://prometheus:9090', maxBytes: 1024, fetchImpl: async () => new Response('x'.repeat(1025)) });
  await assert.rejects(oversized.overview());
  assert.equal(createAdminMonitoring({ baseUrl: 'http://user:secret@prometheus:9090' }).enabled, false);
});

test('admin monitoring client derives staleness from underlying sample time and bounds its queue', async () => {
  const old = (Date.now() - 120_000) / 1000;
  const stale = createAdminMonitoring({ baseUrl: 'http://prometheus:9090', fetchImpl: async url => new Response(JSON.stringify({ status: 'success', data: {
    result: [{ value: [Date.now() / 1000, String(url.searchParams.get('query').includes('timestamp(') ? old : 1)] }],
  } })) });
  assert.equal((await stale.overview()).metrics.apiReplicas.status, 'stale');

  const saturated = createAdminMonitoring({ baseUrl: 'http://prometheus:9090', timeoutMs: 1000, maxConcurrent: 4, maxQueue: 8,
    fetchImpl: async url => { await new Promise(resolve => setTimeout(resolve, 100)); return new Response(JSON.stringify({ status: 'success', data: {
      result: [{ value: [Date.now() / 1000, String(url.searchParams.get('query').includes('timestamp(') ? Date.now() / 1000 : 1)] }],
    } })); } });
  const first = saturated.overview();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(saturated.overview());
  assert.equal((await first).status, 'fresh');
});

test('admin monitoring client preserves a defined zero API replica result', async () => {
  const client = createAdminMonitoring({ baseUrl: 'http://prometheus:9090', fetchImpl: async url => {
    const expression = url.searchParams.get('query');
    const value = expression === 'sum(up{job="bairui-api"}) or vector(0)' ? 0
      : expression === 'min(timestamp(up{job="bairui-api"})) or vector(time())' ? Date.now() / 1000
      : expression.includes('timestamp(') ? Date.now() / 1000 : 1;
    return new Response(JSON.stringify({ status: 'success', data: { result: [{ value: [Date.now() / 1000, String(value)] }] } }));
  } });
  assert.deepEqual((await client.overview()).metrics.apiReplicas.status, 'fresh');
  assert.equal((await client.overview()).metrics.apiReplicas.value, 0);
});
