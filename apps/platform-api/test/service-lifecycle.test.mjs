import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';
import { createServer } from 'node:http';
import { createShutdown } from '../src/service-lifecycle.mjs';
import { PostgresStore } from '../src/postgres-store.mjs';

async function fixture(t, ping) {
  const store = new MemoryStore();
  store.ping = ping;
  const app = createApp({ env: { NODE_ENV: 'test' }, store, readinessTimeoutMs: 30,
    auth: { provider: 'better-auth', resolve: async () => { throw new Error('probe_must_not_authenticate'); } } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return { app, request: path => fetch('http://127.0.0.1:' + app.address().port + path) };
}

test('liveness is independent of the database and authentication', async t => {
  let calls = 0;
  const { request } = await fixture(t, async () => { calls++; throw new Error('private_database_detail'); });
  const response = await request('/livez');
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('readiness and healthz fail closed without leaking database details', async t => {
  const { request } = await fixture(t, async () => { throw new Error('private_database_detail'); });
  for (const path of ['/readyz', '/healthz']) {
    const response = await request(path);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('private_database_detail'), false);
  }
});

test('timed out probes share one pending database check', async t => {
  let calls = 0;
  const { request } = await fixture(t, () => { calls++; return new Promise(() => {}); });
  const responses = await Promise.all(Array.from({ length: 6 }, () => request('/readyz')));
  assert.ok(responses.every(r => r.status === 503));
  assert.equal(calls, 1);
});

test('draining refuses readiness and new work but keeps liveness available', async t => {
  const { app, request } = await fixture(t, async () => ({}));
  assert.equal((await request('/readyz')).status, 200);
  app.platform.beginShutdown();
  for (const path of ['/readyz', '/healthz', '/api/auth/config']) assert.equal((await request(path)).status, 503);
  assert.equal((await request('/livez')).status, 200);
});

test('shutdown drains HTTP before closing the store and is idempotent', async () => {
  const order = [];
  let release, entered;
  const inFlight = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const server = createServer(async (_req, res) => {
    entered();
    await gate;
    order.push('response');
    res.end('ok');
  });
  server.platform = { beginShutdown() { order.push('drain'); }, store: { async close() { order.push('store'); } } };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = fetch('http://127.0.0.1:' + server.address().port);
  await inFlight;
  const shutdown = createShutdown(server, { graceMs: 500 });
  const done = shutdown();
  assert.equal(done, shutdown());
  assert.deepEqual(order, ['drain']);
  release();
  assert.equal(await (await response).text(), 'ok');
  await done;
  assert.deepEqual(order, ['drain', 'response', 'store']);
});

test('idle database connection loss does not crash the process or log credentials', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const store = new PostgresStore({ connectionString: 'postgresql://unused:password@localhost/unused' });
  t.after(() => store.close());
  assert.doesNotThrow(() => store.pool.emit('error', new Error('private_password_in_driver_error')));
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('private_password'));
});
