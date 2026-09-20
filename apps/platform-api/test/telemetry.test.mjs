import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';
import { createShutdown } from '../src/service-lifecycle.mjs';

const principal = { userId: 'test-user', organizationId: 'test-org' };
const auth = { provider: 'better-auth', resolve: async () => principal };

async function tokenFile(t, value = randomBytes(32).toString('hex')) {
  const directory = await mkdtemp(join(tmpdir(), 'bairui-metrics-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'token');
  await writeFile(path, value);
  return { path, token: value.trim() };
}

async function fixture(t, options = {}) {
  const { path, token } = await tokenFile(t);
  const store = options.store ?? new MemoryStore();
  const app = createApp({ ...options, store, auth: options.auth ?? auth,
    env: { NODE_ENV: 'test', BAIRUI_METRICS_ENABLED: '1', BAIRUI_METRICS_TOKEN_FILE: path, ...options.env } });
  t.after(async () => {
    await app.platform.telemetry?.close();
    await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); });
  });
  assert.ok(app.platform.telemetry, 'per-app telemetry is exposed for lifecycle management');
  await app.platform.telemetry.start({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  const metricsBase = 'http://127.0.0.1:' + app.platform.telemetry.server.address().port;
  const scrape = () => fetch(metricsBase + '/metrics', { headers: { authorization: 'Bearer ' + token } });
  return { app, base, metricsBase, token, scrape, store };
}

async function metric(app, name) {
  return (await app.platform.telemetry.registry.getMetricsAsJSON()).find(item => item.name === name);
}

test('metrics default to disabled without opening a listener or reading a token file', async () => {
  const app = createApp({ env: { NODE_ENV: 'test', BAIRUI_METRICS_TOKEN_FILE: 'must-not-read' }, store: new MemoryStore(), auth });
  assert.equal(app.platform.telemetry?.enabled, false);
  assert.equal(app.platform.telemetry.registry, null);
  assert.equal(app.platform.telemetry.server, null);
  await app.platform.telemetry.start();
  await app.platform.telemetry.close();
});

test('enabled metrics fail closed for absent, weak, malformed and oversized tokens and invalid ports', async t => {
  for (const value of ['', 'short', 'x'.repeat(64), '01234567'.repeat(8), 'has whitespace '.repeat(5), 'a'.repeat(4096)]) {
    const { path } = await tokenFile(t, value);
    assert.throws(() => createApp({ env: { NODE_ENV: 'test', BAIRUI_METRICS_ENABLED: '1', BAIRUI_METRICS_TOKEN_FILE: path },
      store: new MemoryStore(), auth }), /metrics_token_invalid/);
  }
  assert.throws(() => createApp({ env: { NODE_ENV: 'test', BAIRUI_METRICS_ENABLED: '1', BAIRUI_METRICS_TOKEN_FILE: 'missing-test-token' },
    store: new MemoryStore(), auth }), /metrics_token_unavailable/);
  const { path } = await tokenFile(t);
  for (const port of ['0', '-1', '65536', 'no', '9464.5', '']) {
    assert.throws(() => createApp({ env: { NODE_ENV: 'test', BAIRUI_METRICS_ENABLED: '1', BAIRUI_METRICS_PORT: port, BAIRUI_METRICS_TOKEN_FILE: path },
      store: new MemoryStore(), auth }), /metrics_port_invalid/);
  }
});

test('dedicated endpoint requires one valid bearer header and never exposes metrics on the API', async t => {
  const { base, metricsBase, token, scrape, app } = await fixture(t);
  assert.equal(app.platform.telemetry.port, 9464);
  for (const authorization of ['', 'Bearer invalid', 'Basic ' + token, 'Bearer ' + token + 'extra', 'Bearer ' + token + ', Bearer ' + token]) {
    const response = await fetch(metricsBase + '/metrics', { headers: { authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.ok(!(await response.text()).includes(token));
  }
  const duplicate = await new Promise((resolve, reject) => {
    const request = httpRequest(metricsBase + '/metrics', { headers: ['Host', new URL(metricsBase).host, 'Authorization', 'Bearer ' + token, 'Authorization', 'Bearer ' + token] }, resolve);
    request.on('error', reject);
    request.end();
  });
  assert.equal(duplicate.statusCode, 401);
  duplicate.resume();
  const response = await scrape();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/plain/);
  assert.match(await response.text(), /process_cpu_user_seconds_total/);
  assert.equal((await fetch(metricsBase + '/other', { headers: { authorization: 'Bearer ' + token } })).status, 404);
  const publicResponse = await fetch(base + '/metrics', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(publicResponse.status, 404);
  assert.ok(!(await publicResponse.text()).includes('bairui_'));
});

test('real HTTP success, validation error and server error are counted exactly once', async t => {
  const store = new MemoryStore();
  store.listResources = async () => { throw new Error('private-db-password'); };
  t.mock.method(console, 'error', () => {});
  const { base, app } = await fixture(t, { store });
  assert.equal((await fetch(base + '/livez')).status, 200);
  assert.equal((await fetch(base + '/api/user/resources?kind=unsupported')).status, 422);
  assert.equal((await fetch(base + '/api/user/resources')).status, 500);
  await delay(10);
  const counter = await metric(app, 'bairui_http_requests_total');
  assert.deepEqual(counter.values.map(value => [value.labels.method, value.labels.route, value.labels.status, value.value]).sort(), [
    ['GET', '/api/user/resources', '422', 1], ['GET', '/api/user/resources', '500', 1], ['GET', '/livez', '200', 1],
  ].sort());
  assert.equal((await metric(app, 'bairui_http_requests_in_flight')).values[0].value, 0);
  const histogram = await metric(app, 'bairui_http_request_duration_seconds');
  assert.equal(histogram.values.filter(value => value.metricName.endsWith('_count')).reduce((sum, value) => sum + value.value, 0), 3);
});

test('aborted HTTP requests decrement in-flight once even when work subsequently finishes', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const store = new MemoryStore();
  store.listResources = async () => { enter(); await pending; return []; };
  const { base, app } = await fixture(t, { store });
  t.after(() => release());
  const request = httpRequest(base + '/api/user/resources');
  request.on('error', () => {});
  request.end();
  await entered;
  assert.equal((await metric(app, 'bairui_http_requests_in_flight')).values[0].value, 1);
  request.destroy();
  await new Promise(resolve => request.once('close', resolve));
  await delay(30);
  release();
  await delay(30);
  const counter = await metric(app, 'bairui_http_requests_total');
  assert.deepEqual(counter.values.map(value => [value.labels.status, value.value]), [['499', 1]]);
  assert.equal((await metric(app, 'bairui_http_requests_in_flight')).values[0].value, 0);
});

test('route, method and status labels stay bounded and omit IDs, email, query, body and headers', async t => {
  const { base, app, scrape } = await fixture(t);
  for (let index = 0; index < 24; index++) {
    const marker = 'private-person-' + index + '@example.test';
    await fetch(base + '/api/user/resources/' + marker + '?secret=query-private', {
      headers: { 'x-request-id': 'header-private', cookie: 'session=cookie-private' },
    });
    await fetch(base + '/unknown/' + marker);
  }
  await fetch(base + '/api/user/resources', { method: 'POST', body: JSON.stringify({ private: 'body-private' }) });
  await fetch(base + '/unknown/method', { method: 'PROPFIND' });
  const counter = await metric(app, 'bairui_http_requests_total');
  assert.equal(counter.values.length, 4);
  assert.ok(counter.values.some(value => value.labels.method === 'OTHER'));
  assert.ok(counter.values.some(value => value.labels.route === '/api/user/resources/:resourceId'));
  assert.ok(counter.values.some(value => value.labels.route === 'unmatched'));
  const text = await (await scrape()).text();
  assert.doesNotMatch(text, /private-person|example\.test|query-private|header-private|cookie-private|body-private/);
});

test('each app has an isolated registry and default Node process metrics', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  assert.notEqual(first.app.platform.telemetry.registry, second.app.platform.telemetry.registry);
  await fetch(first.base + '/livez');
  assert.equal((await metric(first.app, 'bairui_http_requests_total')).values.length, 1);
  assert.equal((await metric(second.app, 'bairui_http_requests_total')).values.length, 0);
  assert.match(await (await second.scrape()).text(), /nodejs_version_info/);
});

test('database outages and throwing pool statistics never break scraping', async t => {
  const store = new MemoryStore();
  let healthy = true;
  store.ping = async () => { if (!healthy) throw new Error('postgres://private-password@example'); };
  store.pool = { totalCount: 4, idleCount: 2, waitingCount: 1, options: { max: 9 } };
  const { scrape } = await fixture(t, { store });
  let text = await (await scrape()).text();
  assert.match(text, /bairui_database_ready 1/);
  assert.match(text, /bairui_db_pool_connections\{state="total"\} 4/);
  assert.match(text, /bairui_db_pool_connections\{state="idle"\} 2/);
  assert.match(text, /bairui_db_pool_connections\{state="waiting"\} 1/);
  assert.match(text, /bairui_db_pool_max 9/);
  healthy = false;
  Object.defineProperty(store.pool, 'idleCount', { get() { throw new Error('pool-secret'); } });
  const response = await scrape();
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /bairui_database_ready 0/);
  assert.match(text, /bairui_db_pool_connections\{state="idle"\} 0/);
  assert.doesNotMatch(text, /private-password|pool-secret/);
  healthy = true;
  assert.match(await (await scrape()).text(), /bairui_database_ready 1/);
});

test('hung readiness is bounded and concurrent scrapes share a single probe', async t => {
  let calls = 0;
  const store = new MemoryStore();
  store.ping = () => { calls++; return new Promise(() => {}); };
  const { scrape } = await fixture(t, { store, metricsReadinessTimeoutMs: 25 });
  const responses = await Promise.all(Array.from({ length: 5 }, scrape));
  assert.ok(responses.every(response => response.status === 200));
  for (const response of responses) assert.match(await response.text(), /bairui_database_ready 0/);
  assert.equal(calls, 1);
});

test('shutdown closes the metrics listener and is idempotent', async t => {
  const { app, metricsBase } = await fixture(t);
  const shutdown = createShutdown(app);
  await shutdown();
  await app.platform.telemetry.close();
  await app.platform.telemetry.close();
  assert.equal(app.platform.telemetry.server.listening, false);
  await assert.rejects(fetch(metricsBase + '/metrics'));
});
