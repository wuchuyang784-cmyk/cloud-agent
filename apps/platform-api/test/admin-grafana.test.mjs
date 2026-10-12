import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';
import { createGrafanaProxy } from '../src/admin/grafana-proxy.mjs';
import { createAdminMonitoring } from '../src/admin/monitoring.mjs';

async function fixture(t, upstreamHandler) {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, headers: req.headers, body });
    if (upstreamHandler) return upstreamHandler(req, res);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'grafana_session=not-for-browser', 'x-internal-secret': 'hidden' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const store = new MemoryStore({ seed: { users: [
    { id: 'viewer', email: 'viewer@example.test', organizationId: 'org-a', role: 'user' },
    { id: 'ordinary', email: 'ordinary@example.test', organizationId: 'org-b', role: 'user' },
  ] } });
  store.platformRoles = new Map([['viewer', { role: 'platform_viewer', revokedAt: null }]]);
  let signedOut = false;
  const app = createApp({ store, auth: { provider: 'better-auth', async resolve(req) {
    const user = !signedOut && store.findUser(req.headers['x-test-user']);
    return user && { userId: user.id, organizationId: user.organizationId, email: user.email };
  } }, env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth',
    BAIRUI_GRAFANA_UPSTREAM_URL: 'http://127.0.0.1:' + upstream.address().port,
    BAIRUI_MONITORING_PROXY_TOKEN: 'b'.repeat(64), BAIRUI_GRAFANA_PUBLIC_ORIGIN: 'http://localhost:5173' } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return { seen, store, signOut: () => { signedOut = true; }, request: (path, user = 'viewer', init = {}) => fetch(
    'http://127.0.0.1:' + app.address().port + '/api/admin/grafana/' + path,
    { ...init, headers: { ...(user ? { 'x-test-user': user } : {}), ...init.headers }, redirect: 'manual' }) };
}

test('Grafana same-origin gateway checks platform access on every request and replaces untrusted headers', async t => {
  const { request, seen, store, signOut } = await fixture(t);
  assert.equal((await request('api/user', null)).status, 401);
  assert.equal((await request('api/user', 'ordinary')).status, 403);
  const result = await request('api/user', 'viewer', { headers: { cookie: 'business-session=secret', authorization: 'Bearer attacker',
    'x-bairui-monitor-user': 'admin', 'x-bairui-monitor-role': 'Admin', 'x-forwarded-for': 'attacker' } });
  assert.equal(result.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, 'Bearer ' + 'b'.repeat(64));
  assert.equal(seen[0].headers['x-bairui-monitor-user'], 'bairui:viewer');
  assert.equal(seen[0].headers['x-bairui-monitor-role'], 'Viewer');
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers['x-forwarded-for'], undefined);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('x-internal-secret'), null);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  store.accountGovernance = new Map([['viewer', { status: 'suspended', version: 1 }]]);
  assert.equal((await request('api/user')).status, 403);
  store.accountGovernance.clear(); store.platformRoles.get('viewer').revokedAt = new Date().toISOString();
  assert.equal((await request('api/user')).status, 403);
  store.platformRoles.get('viewer').revokedAt = null; signOut();
  assert.equal((await request('api/user')).status, 401);
  assert.equal(seen.length, 1);
});

test('Grafana permits fixed dashboard queries but denies arbitrary PromQL, writes and foreign origins', async t => {
  const { request, seen } = await fixture(t);
  const input = { from: String(Date.now() - 60000), to: String(Date.now()), queries: [{ refId: 'A', expr: 'sum(up{job="bairui-api"}) or vector(0)',
    datasource: { type: 'prometheus', uid: 'bairui-prometheus' }, intervalMs: 15000, maxDataPoints: 1000, instant: true }] };
  const post = body => ({ method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request('api/ds/query', 'viewer', post(input))).status, 200);
  assert.equal(seen.length, 1);
  assert.equal(JSON.parse(seen[0].body).queries[0].range, false, 'instant stat queries must not duplicate a range frame');
  assert.equal((await request('api/ds/query', 'viewer', post({ ...input, queries: [{ ...input.queries[0], expr: 'up' }] }))).status, 422);
  assert.equal((await request('api/ds/query', 'viewer', { ...post(input), headers: { origin: 'https://attacker.example', 'content-type': 'application/json' } })).status, 403);
  for (const path of ['api/dashboards/db', 'api/admin/users', 'api/datasources/proxy/uid/bairui-prometheus/api/v1/query?query=up', 'api/dashboards/uid/other', 'login']) {
    assert.ok([404, 405].includes((await request(path)).status), path);
  }
  assert.equal(seen.length, 1);
});

test('Grafana redirects cannot escape the fixed same-origin subpath and upstream failure is isolated', async t => {
  const { request } = await fixture(t, (_req, res) => { res.writeHead(302, { location: 'https://attacker.example/', 'set-cookie': 'secret=hidden' }); res.end(); });
  const result = await request('d/bairui-platform/bairui-platform?kiosk');
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('location'), null);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal((await result.json()).error.code, 'grafana_unavailable');
});

test('Grafana 13 fixed read-only discovery, preferences and dashboard DTO remain usable without a general Kubernetes proxy', async t => {
  const { request, seen } = await fixture(t);
  for (const path of ['api/folders/bairui-platform-folder?accesscontrol=true&isLegacyCall=true', 'apis/preferences.grafana.app/v1/namespaces/default/preferences/merged',
    'apis/features.grafana.app/v0alpha1/namespaces/default/ofrep/v1/evaluate/flags', 'apis/dashboard.grafana.app/',
    'apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/bairui-platform/dto',
    'apis/dashboard.grafana.app/v2/namespaces/default/dashboards/bairui-platform/dto']) assert.equal((await request(path)).status, 200, path);
  for (const path of ['apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/other/dto',
    'apis/dashboard.grafana.app/v2beta1/namespaces/other/dashboards/bairui-platform/dto']) assert.equal((await request(path)).status, 404);
  assert.equal(seen.length, 6);
});

test('Grafana 13 feature evaluation is a fixed sanitized read and frontend telemetry is discarded locally', async t => {
  const { request, seen } = await fixture(t);
  const post = { method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: JSON.stringify({ context: { arbitraryIdentity: 'must-not-forward' } }) };
  const flags = 'apis/features.grafana.app/v0alpha1/namespaces/default/ofrep/v1/evaluate/flags';
  assert.equal((await request(flags, 'viewer', post)).status, 200);
  assert.deepEqual(JSON.parse(seen[0].body), { context: {} });
  assert.equal((await request('api/frontend-metrics', 'viewer', post)).status, 204);
  assert.equal(seen.length, 1, 'telemetry must never reach upstream or be stored');
  assert.equal((await request(flags, 'viewer', { ...post, headers: { ...post.headers, origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request('api/frontend-metrics', null, post)).status, 401);
});

test('native asset cache and annotations flags are confined to their fixed read paths', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('public/plugins/prometheus/module.js?_cache=13.2.2')).status, 200);
  assert.equal((await request('api/annotations?matchAny=false&dashboardUID=bairui-platform')).status, 200);
  assert.equal((await request('api/user?_cache=x')).status, 422);
  assert.equal((await request('api/user?matchAny=true')).status, 422);
});

test('monitoring bridge uses its private bearer, never a browser-selected upstream or token', async () => {
  const seen = [];
  const monitoring = createAdminMonitoring({ baseUrl: 'http://127.0.0.1:9493/prometheus', token: 'c'.repeat(64), fetchImpl: async (url, options) => {
    seen.push({ url: String(url), headers: options.headers });
    return new Response(JSON.stringify({ status: 'success', data: { alerts: [] } }));
  } });
  await monitoring.alerts();
  assert.equal(seen[0].url, 'http://127.0.0.1:9493/prometheus/api/v1/alerts');
  assert.equal(seen[0].headers.authorization, 'Bearer ' + 'c'.repeat(64));
});

test('Grafana gateway bounds bytes and concurrent requests and hides transport details', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const gateway = createGrafanaProxy({ baseUrl: 'http://127.0.0.1:9493', token: 'd'.repeat(64), publicOrigin: 'http://localhost:5173',
    maxBytes: 1024, maxConcurrent: 1, fetchImpl: () => pending });
  const codes = [];
  const input = { request: { url: '/api/admin/grafana/api/user', method: 'GET', headers: {} }, response: { destroyed: false },
    url: new URL('http://platform/api/admin/grafana/api/user'), principal: { userId: 'viewer' }, fail: (status, code) => codes.push([status, code]) };
  const first = gateway.handle(input);
  await gateway.handle(input); assert.deepEqual(codes, [[503, 'grafana_unavailable']]);
  resolve(new Response('x'.repeat(1025))); await first;
  assert.deepEqual(codes, [[503, 'grafana_unavailable'], [503, 'grafana_unavailable']]);
});

test('Grafana body readers share the concurrency bound and failed upstream bodies are cancelled', async () => {
  let finishBody;
  const body = new Promise(resolve => { finishBody = resolve; });
  const failures = [];
  const gateway = createGrafanaProxy({ baseUrl: 'http://127.0.0.1:9493', token: 'e'.repeat(64), publicOrigin: 'http://localhost:5173', maxConcurrent: 1 });
  const input = { request: { url: '/api/admin/grafana/api/ds/query', method: 'POST', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' } },
    response: { destroyed: false }, url: new URL('http://platform/api/admin/grafana/api/ds/query'), principal: { userId: 'viewer' },
    readJson: () => body, fail: (status, code) => failures.push([status, code]) };
  const first = gateway.handle(input); await gateway.handle(input);
  assert.deepEqual(failures, [[503, 'grafana_unavailable']]); finishBody({}); await first;
  assert.equal(failures[1][0], 422);
  let cancelled = false;
  const broken = createGrafanaProxy({ baseUrl: 'http://127.0.0.1:9493', token: 'e'.repeat(64), publicOrigin: 'http://localhost:5173',
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 }) });
  await broken.handle({ ...input, request: { url: '/api/admin/grafana/api/user', method: 'GET', headers: {} }, url: new URL('http://platform/api/admin/grafana/api/user') });
  assert.equal(cancelled, true);
});
