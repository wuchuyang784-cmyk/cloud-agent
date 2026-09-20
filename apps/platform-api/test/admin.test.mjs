import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';
import { readAdmin } from '../src/admin/store.mjs';

test('admin: uncertain rollback discards the pooled connection', async () => {
  const failure = new Error('query_failure');
  const rollback = new Error('rollback_failure');
  let released;
  const client = { async query(sql) { if (sql.includes('platform_account_access')) return { rows: [{ result: { status: 'active', version: 0 } }] }; if (sql.startsWith('SELECT')) throw failure; if (sql === 'ROLLBACK') throw rollback; }, release(error) { released = error; } };
  await assert.rejects(readAdmin({ pool: { async connect() { return client; } } }, 'actor', 'users'), error => error === failure);
  assert.equal(released, rollback);
});

const seed = { users: [
  { id: 'user-a', email: 'a@example.test', organizationId: 'org-a', role: 'org_admin', passwordHash: 'never-return-password' },
  { id: 'user-b', email: 'b@example.test', organizationId: 'org-b', role: 'platform_admin', authSubject: 'never-return-subject' },
], agents: [
  { id: 'agent-a', name: 'Agent A', organizationId: 'org-a', ownerUserId: 'user-a', status: 'ready', engine: 'mock', runtimeUrl: 'http://private-secret-runtime', config: { apiKey: 'never-return-key' } },
  { id: 'agent-b', name: 'Agent B', organizationId: 'org-b', ownerUserId: 'user-b', status: 'stopped', engine: 'pi' },
] };

async function fixture(t) {
  const store = new MemoryStore({ seed });
  const auth = { provider: 'better-auth', async resolve(req) {
    const user = store.findUser(req.headers['x-test-user']);
    return user && { userId: user.id, organizationId: user.organizationId, role: user.role, email: user.email };
  } };
  const app = createApp({ store, auth, env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth' } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  return { store, get: (path, user = 'user-a', options = {}) => fetch('http://127.0.0.1:' + app.address().port + path, { ...options, headers: { ...(user ? { 'x-test-user': user } : {}), ...options.headers } }) };
}

test('admin: anonymous, personal owner and historical organization admin cannot access global APIs', async t => {
  const { get } = await fixture(t);
  assert.equal((await get('/api/admin/users', null)).status, 401);
  for (const user of ['user-a', 'user-b']) {
    for (const path of ['/api/admin/me', '/api/admin/users', '/api/admin/agents']) {
      assert.equal((await get(path, user, { headers: { 'x-platform-role': 'platform_admin' } })).status, 403);
    }
  }
});

test('admin: explicit read role, bounded pagination, safe projection and immediate revocation', async t => {
  const { store, get } = await fixture(t);
  store.platformRoles ??= new Map();
  store.platformRoles.set('user-a', { role: 'platform_viewer', revokedAt: null });
  const me = await get('/api/admin/me');
  assert.equal(me.status, 200);
  assert.equal(me.headers.get('cache-control'), 'no-store');
  assert.equal((await me.json()).role, 'platform_viewer');
  const first = await get('/api/admin/users?limit=1');
  assert.equal(first.status, 200);
  const page = await first.json();
  assert.deepEqual(page.items.map(x => x.id), ['user-a']);
  assert.equal(page.nextCursor, 'user-a');
  const second = await (await get('/api/admin/users?limit=1&after=' + page.nextCursor)).json();
  assert.deepEqual(second.items.map(x => x.id), ['user-b']);
  assert.equal(second.nextCursor, null);
  assert.equal(JSON.stringify([page, second]).includes('never-return'), false);
  const agents = await (await get('/api/admin/agents')).json();
  assert.equal(agents.items.length, 2);
  assert.equal(JSON.stringify(agents).includes('runtime'), false);
  assert.equal(JSON.stringify(agents).includes('never-return'), false);
  assert.equal((await (await get('/api/admin/agents?ownerUserId=user-b&status=stopped')).json()).items[0].id, 'agent-b');
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'role=platform_admin', 'organizationId=org-b', 'limit=1&limit=2']) {
    assert.equal((await get('/api/admin/users?' + query)).status, 422, query);
  }
  assert.equal((await get('/api/admin/agents?status=invalid')).status, 422);
  assert.equal((await get('/api/admin/users', 'user-a', { method: 'POST' })).status, 405);
  assert.equal((await get('/api/admin/agents/agent-b/stop', 'user-a', { method: 'POST' })).status, 404);
  assert.equal((await get('/api/user/agents/agent-b')).status, 404);
  store.platformRoles.get('user-a').revokedAt = new Date().toISOString();
  assert.equal((await get('/api/admin/me')).status, 403);
  assert.equal((await get('/api/admin/agents')).status, 403);
});
