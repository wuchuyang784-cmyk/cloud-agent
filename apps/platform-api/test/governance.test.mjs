import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { changeGovernance } from '../src/admin/governance.mjs';
import { routeLabel } from '../src/observability/labels.mjs';

test('governance: metrics labels never contain account IDs or audit cursors', () => {
  assert.equal(routeLabel('/api/admin/users/private-user/governance?after=123'), '/api/admin/users/:userId/governance');
});

async function fixture(t) {
  const users = ['admin', 'other-admin', 'viewer', 'operator', 'user'].map(id => ({ id, email: id + '@example.test', organizationId: 'org-' + id, role: 'org_admin' }));
  const store = new MemoryStore({ seed: { users } });
  store.platformRoles = new Map([['admin', { role: 'platform_admin' }], ['other-admin', { role: 'platform_admin' }], ['viewer', { role: 'platform_viewer' }], ['operator', { role: 'platform_operator' }]]);
  const auth = { provider: 'better-auth', async resolve(req) { const u = store.users.get(req.headers['x-test-user']); return u && { userId: u.id, organizationId: u.organizationId }; } };
  const origin = 'http://localhost:5173';
  const app = createApp({ store, auth, env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: origin } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const request = (path, actor = 'admin', init = {}) => fetch('http://127.0.0.1:' + app.address().port + path, { ...init, headers: { origin, 'content-type': 'application/json', 'x-test-user': actor, ...init.headers } });
  const change = (target, status, expectedVersion = 0, actor = 'admin', extra = {}) => request('/api/admin/users/' + target + '/governance', actor, { method: 'POST', body: JSON.stringify({ status, expectedVersion, reason: 'test reason', requestId: randomUUID(), ...extra }) });
  return { store, request, change };
}

test('governance: admin-only writes, origin, validation and self protection', async t => {
  const { request, change } = await fixture(t);
  for (const actor of ['user', 'viewer', 'operator']) assert.equal((await change('user', 'suspended', 0, actor)).status, 403);
  assert.equal((await change('admin', 'banned')).status, 409);
  assert.equal((await change('missing', 'banned')).status, 404);
  assert.equal((await change('user', 'wrong')).status, 422);
  assert.equal((await change('user', 'banned', 0, 'admin', { actor: 'other-admin' })).status, 422);
  assert.equal((await request('/api/admin/users/user/governance', 'admin', { method: 'POST', headers: { origin: 'https://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/admin/users/user/governance?actor=admin')).status, 422);
});

test('governance: versioning, idempotency, audit, suspension reads and universal write gate', async t => {
  const { request, change } = await fixture(t);
  const requestId = randomUUID();
  const result = await change('user', 'suspended', 0, 'admin', { requestId });
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal((await result.json()).account.version, 1);
  assert.equal((await change('user', 'suspended', 0, 'admin', { requestId })).status, 200);
  assert.equal((await change('user', 'banned', 0, 'admin', { requestId })).status, 409);
  assert.equal((await change('user', 'banned', 0)).status, 409);
  assert.equal((await request('/api/user/resources', 'user')).status, 200);
  const me = await (await request('/api/auth/me', 'user')).json();
  assert.equal(me.user.accountStatus, 'suspended');
  assert.equal((await request('/api/user/resources', 'user', { method: 'POST', body: JSON.stringify({ kind: 'skill', name: 'blocked' }) })).status, 403);
  const history = await (await request('/api/admin/users/user/governance', 'viewer')).json();
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].reason, 'test reason');
  assert.equal((await change('user', 'banned', 1)).status, 200);
  assert.equal((await request('/api/auth/me', 'user')).status, 401);
  assert.equal((await change('user', 'active', 2)).status, 200);
  assert.equal((await change('user', 'suspended', 0, 'admin', { requestId })).status, 200);
  assert.equal((await (await request('/api/auth/me', 'user')).json()).user.accountStatus, 'active');
  assert.equal((await request('/api/user/agents', 'user', { method: 'POST', body: '{}' })).status, 403);
});

test('governance MemoryStore: real Better Auth sessions are revoked and not restored after unban', async t => {
  const store = new MemoryStore();
  const database = { ba_user: [], ba_session: [], ba_account: [], ba_verification: [], ba_rate_limit: [] };
  const origin = 'http://localhost:5173';
  const app = createApp({ store, env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: 'disposable-memory-governance-secret-32' }, authOptions: { betterAuthDatabase: memoryAdapter(database) } });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => app.close(r)));
  const request = (path, cookie = '', body) => fetch('http://127.0.0.1:' + app.address().port + path, {
    method: body ? 'POST' : 'GET', headers: { origin, cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const identities = [];
  for (const email of ['memory-admin@example.test', 'memory-user@example.test']) {
    const response = await request('/api/auth/sign-up/email', '', { email, name: email, password: 'memory-test-password' });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
    const { user } = await (await request('/api/auth/me', cookie)).json();
    identities.push({ ...user, cookie, email });
  }
  const [admin, user] = identities;
  store.platformRoles = new Map([[admin.userId, { role: 'platform_admin' }]]);
  const change = (status, expectedVersion) => changeGovernance(store, admin.userId, user.userId, { status, expectedVersion, reason: 'test governance', requestId: randomUUID() });
  await change('suspended', 0);
  const signIn = () => request('/api/auth/sign-in/email', '', { email: user.email, password: 'memory-test-password' });
  assert.equal((await signIn()).status, 200);
  await change('banned', 1);
  assert.equal((await request('/api/auth/me', user.cookie)).status, 401);
  assert.equal((await signIn()).status, 403);
  await change('active', 2);
  assert.equal((await request('/api/auth/me', user.cookie)).status, 401);
  assert.equal((await signIn()).status, 200);
});

test('governance: restricted administrators cannot govern, stale replies cannot undo newer decisions', async t => {
  const { request, change } = await fixture(t);
  assert.equal((await change('other-admin', 'suspended')).status, 200);
  assert.equal((await change('admin', 'banned', 0, 'other-admin')).status, 403);
  assert.equal((await request('/api/admin/users', 'other-admin')).status, 403);
  const outcomes = await Promise.all([change('user', 'suspended'), change('user', 'banned')]);
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
});
