import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';

test('monitoring access rechecks active platform authorization on every request', async t => {
  const store = new MemoryStore({ seed: { users: [{ id: 'user-a', email: 'a@example.test', organizationId: 'org-a', role: 'user' }] } });
  store.platformRoles = new Map([['user-a', { role: 'platform_viewer', revokedAt: null }]]);
  const auth = { provider: 'better-auth', async resolve(req) { return req.headers['x-test-user'] === 'user-a' && { userId: 'user-a', organizationId: 'org-a', email: 'a@example.test' }; } };
  const app = createApp({ store, auth, env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth' } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const call = (init = {}) => fetch('http://127.0.0.1:' + app.address().port + '/api/admin/monitoring/access',
    { ...init, headers: { 'x-test-user': 'user-a', ...init.headers } });
  for (const role of ['platform_viewer', 'platform_operator', 'platform_admin']) {
    store.platformRoles.set('user-a', { role, revokedAt: null });
    const ok = await call();
    assert.equal(ok.status, 204, role);
    assert.equal(ok.headers.get('x-bairui-monitor-user'), 'bairui:user-a');
    assert.equal(ok.headers.get('x-bairui-monitor-role'), 'Viewer');
  }
  assert.equal((await call({ method: 'POST' })).status, 405);
  store.accountGovernance = new Map([['user-a', { status: 'suspended', version: 1, changedAt: new Date().toISOString() }]]);
  assert.equal((await call()).status, 403);
  store.accountGovernance.set('user-a', { status: 'banned', version: 2, changedAt: new Date().toISOString() });
  assert.equal((await call()).status, 401);
  store.accountGovernance.set('user-a', { status: 'active', version: 3, changedAt: new Date().toISOString() });
  store.platformRoles.get('user-a').revokedAt = new Date().toISOString();
  assert.equal((await call()).status, 403);
  assert.equal((await fetch('http://127.0.0.1:' + app.address().port + '/api/admin/monitoring/access')).status, 401);
});
