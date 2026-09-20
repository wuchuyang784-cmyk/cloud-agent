import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';

test('infrastructure API: explicit role only, read-only, bounded query and immediate revocation', async t => {
  const store = new MemoryStore({ seed: { users: [{ id: 'operator', email: 'operator@example.test', organizationId: 'org-a', role: 'org_admin' }] } });
  const app = createApp({ store, env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth' },
    auth: { provider: 'better-auth', async resolve(req) { return req.headers['x-test-user'] ? { userId: 'operator', organizationId: 'org-a', role: 'org_admin' } : null; } } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const get = (suffix = '', options = {}) => fetch('http://127.0.0.1:' + app.address().port + '/api/admin/infrastructure' + suffix,
    { headers: { 'x-test-user': 'operator' }, ...options });
  assert.equal((await get('', { headers: {} })).status, 401);
  assert.equal((await get()).status, 403);
  store.platformRoles = new Map([['operator', { role: 'platform_viewer' }]]);
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await response.json()).items, []);
  assert.equal((await get('?actor=other')).status, 422);
  assert.equal((await get('?limit=100')).status, 422);
  assert.equal((await get('', { method: 'POST' })).status, 405);
  store.platformRoles.get('operator').revokedAt = new Date().toISOString();
  assert.equal((await get()).status, 403);
  let roleReads = 0;
  t.mock.method(store.platformRoles, 'get', () => ({ role: 'platform_viewer', revokedAt: ++roleReads === 1 ? null : new Date().toISOString() }));
  assert.equal((await get()).status, 403, 'revocation between the route precheck and infrastructure read is rechecked');
  assert.equal(roleReads, 2);
});
