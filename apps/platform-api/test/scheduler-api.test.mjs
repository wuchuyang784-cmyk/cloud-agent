import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

test('simulation API: default closed, allowlist, origin, ownership and scope injection', async () => {
  const env = { NODE_ENV: 'test', BAIRUI_SIMULATION_ENABLED: '1', BAIRUI_SIMULATION_USERS: 'a@test.local,b@test.local', BETTER_AUTH_URL: 'http://localhost:5173' };
  const auth = { resolve: async req => req.headers['x-test-user'] ? { userId: req.headers['x-test-user'], organizationId: 'org-' + req.headers['x-test-user'], email: req.headers['x-test-user'] + '@test.local' } : null };
  async function withApp(config, fn) {
    const app = createApp({ env: config, auth });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    try { await fn('http://127.0.0.1:' + app.address().port); }
    finally { await new Promise(resolve => app.close(resolve)); }
  }
  await withApp(env, async base => {
    const url = base + '/api/simulation/tasks';
    const headers = { 'x-test-user': 'a', origin: env.BETTER_AUTH_URL, 'content-type': 'application/json', 'idempotency-key': 'one' };
    const post = (body, extra = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const input = { durationMs: 2000, outcome: 'success' };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-test-user': 'c' } })).status, 404);
    assert.equal((await post(input, { origin: 'http://evil.test' })).status, 403);
    assert.equal((await post({ ...input, userId: 'b' })).status, 422);
    for (const bad of [null, [], 5, { ...input, durationMs: 1 }]) assert.equal((await post(bad)).status, 422);
    const response = await post(input); assert.equal(response.status, 201);
    const { task } = await response.json(); assert.equal(task.userId, 'a');
    assert.equal((await (await post(input)).json()).task.id, task.id);
    assert.equal((await post({ ...input, durationMs: 3000 })).status, 409);
    assert.equal((await fetch(url + '/' + task.id, { headers: { 'x-test-user': 'b' } })).status, 404);
    assert.equal((await fetch(url + '/' + task.id + '/cancel', { method: 'POST', headers: { ...headers, 'x-test-user': 'b' } })).status, 404);
    assert.equal((await (await fetch(url + '/' + task.id + '/cancel', { method: 'POST', headers })).json()).task.status, 'cancelled');
  });
  for (const config of [{ ...env, BAIRUI_SIMULATION_ENABLED: '0' }]) {
    await withApp(config, async base => assert.equal((await fetch(base + '/api/simulation/tasks', { headers: { 'x-test-user': 'a' } })).status, 404));
  }
  assert.throws(() => createApp({ env: { ...env, NODE_ENV: 'production' }, auth }), /BAIRUI_AUTH_MODE/);
});
