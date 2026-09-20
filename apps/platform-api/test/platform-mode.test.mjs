import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';

const scope = { userId: 'one', organizationId: 'personal-one', email: 'one@example.test' };
async function fixture(t, extra = {}) {
  const store = new MemoryStore({ seed: { agents: [
    { id: 'historic', name: 'Historic', status: 'ready', ownerUserId: scope.userId, organizationId: scope.organizationId },
    { id: 'other', name: 'Private', status: 'ready', ownerUserId: 'two', organizationId: 'personal-two' },
  ] } });
  const app = createApp({ env: { NODE_ENV: 'test' }, store,
    auth: { provider: 'better-auth', resolve: async req => req.headers.authorization === 'test-session' ? scope : null }, ...extra });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const request = (path, init = {}) => fetch('http://127.0.0.1:' + app.address().port + path, {
    ...init, headers: { authorization: 'test-session', 'content-type': 'application/json', ...init.headers },
  });
  return { app, store, request };
}

test('platform defaults advertise disabled execution and simulated payments', async t => {
  const { app, request } = await fixture(t);
  const result = await request('/api/auth/config');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await result.json()).capabilities, { mode: 'platform', agentLifecycle: false, agentExecution: false, simulatedRecharge: false });
  assert.equal(app.platform.runtime, null);
});

test('platform rejects all agent mutations and recharge before any side effect', async t => {
  const { request, store } = await fixture(t);
  const original = JSON.stringify([...store.agents]);
  const paths = ['/api/user/agents', '/api/user/agents/historic/sessions',
    '/api/user/agents/historic/sessions/example/chat/stream', '/api/user/agents/historic/start',
    '/api/user/agents/historic/stop', '/api/user/billing/recharge'];
  for (const path of paths) {
    const response = await request(path, { method: 'POST', body: '{invalid-json' });
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).error.code, 'capability_disabled');
  }
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    assert.equal((await request('/api/user/agents/historic', { method, body: '{}' })).status, 403);
  }
  assert.equal((await request('/api/user/agents', { method: 'POST', headers: { authorization: '' }, body: '{}' })).status, 401);
  assert.equal(JSON.stringify([...store.agents]), original);
  for (const collection of ['sessions', 'messages', 'transactions', 'accounts', 'idempotency']) assert.equal(store[collection].size, 0);
  assert.equal(store.outbox.length, 0);
});

test('platform keeps scoped history and resource CRUD available', async t => {
  const { request } = await fixture(t);
  assert.equal((await (await request('/api/user/agents')).json()).agents.length, 1);
  assert.equal((await request('/api/user/agents/other')).status, 404);
  const created = await request('/api/user/resources', { method: 'POST', body: JSON.stringify({ kind: 'skill', name: 'Saved skill' }) });
  assert.equal(created.status, 201);
  const { resource } = await created.json();
  assert.equal((await request('/api/user/resources/' + resource.id)).status, 200);
  assert.equal((await request('/api/user/resources/' + resource.id, { method: 'PATCH', body: JSON.stringify({ name: 'Updated' }) })).status, 200);
  assert.equal((await request('/api/user/resources/' + resource.id, { method: 'DELETE' })).status, 204);
});

test('platform configuration fails closed instead of falling back to memory or legacy auth', () => {
  assert.throws(() => createApp({ env: {} }), /BAIRUI_AUTH_MODE/);
  assert.throws(() => createApp({ env: { BAIRUI_AUTH_MODE: 'better-auth' } }), /PostgreSQL.*DATABASE_URL/);
  assert.throws(() => createApp({ env: { BAIRUI_PLATFORM_MODE: 'typo' } }), /BAIRUI_PLATFORM_MODE/);
  assert.throws(() => createApp({ env: { NODE_ENV: 'production', BAIRUI_PLATFORM_MODE: 'legacy' } }), /legacy/);
});

test('platform startup refuses old worker, mock runtime and boundary before opening connections', async () => {
  const exec = promisify(execFile);
  for (const file of ['worker-index.mjs', 'mock-runtime-server.mjs', 'runtime/boundary-server.mjs']) {
    await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('../src/' + file, import.meta.url))], {
      env: { ...process.env, NODE_ENV: 'test', BAIRUI_PLATFORM_MODE: 'platform', DATABASE_URL: '', PORT: '0' },
      timeout: 4000, windowsHide: true,
    }), error => !error.killed && /agent_runtime_disabled/.test(error.stderr), file);
  }
});
