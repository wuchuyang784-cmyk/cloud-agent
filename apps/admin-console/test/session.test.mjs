import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminSession } from '../src/session.ts';

const me = { role: 'platform_viewer', permissions: ['users:read', 'agents:read'], user: { id: 'admin', email: 'admin@example.test' } };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('governance UI: timeout retry preserves request identity, confirmed changes refresh status', async () => {
  const commands = []; let attempts = 0;
  const model = new AdminSession(async (path, options) => {
    if (path.endsWith('/governance') && options?.method === 'POST') {
      commands.push(JSON.parse(options.body));
      if (++attempts === 1) throw new Error('network_lost');
      return response({ account: { status: 'suspended', version: 1 } });
    }
    return response(path === '/api/admin/me' ? { ...me, role: 'platform_admin', permissions: [...me.permissions, 'users:govern'] }
      : path.endsWith('/governance') ? { account: { status: attempts > 1 ? 'suspended' : 'active', version: attempts > 1 ? 1 : 0 }, items: [], nextCursor: null }
      : { items: [{ id: 'target', email: 'target@example.test' }], nextCursor: null });
  });
  await model.load({ view: 'users' });
  await model.openGovernance({ id: 'target' });
  await model.govern('suspended', 'test reason');
  assert.ok(model.getSnapshot().governance.retry);
  assert.equal(model.getSnapshot().governance.success, '');
  await model.govern('banned', 'changed input must not alter retry');
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(model.getSnapshot().governance.account.status, 'suspended');
  assert.ok(model.getSnapshot().governance.success);
});

test('governance UI: logout and navigation clear sensitive detail and ignore late mutation responses', async () => {
  const pending = deferred();
  const model = new AdminSession(async (path, options) => path.includes('sign-out') ? response({})
    : path === '/api/admin/me' ? response({ ...me, role: 'platform_admin', permissions: [...me.permissions, 'users:govern'] })
    : options?.method === 'POST' ? pending.promise
    : path.endsWith('/governance') ? response({ account: { status: 'active', version: 0 }, items: [], nextCursor: null })
    : response({ items: [], nextCursor: null }));
  await model.load({ view: 'users' }); await model.openGovernance({ id: 'target' });
  const change = model.govern('banned', 'test reason');
  await model.signOut(); pending.resolve(response({})); await change;
  assert.equal(model.getSnapshot().phase, 'login');
  assert.equal(model.getSnapshot().governance, null);
});

test('infrastructure UI: dedicated permission, no list query, clear telemetry on logout and ignore late responses', async () => {
  const pending = deferred(), calls = [];
  const model = new AdminSession(async path => {
    calls.push(path);
    return path === '/api/admin/me' ? response({ ...me, permissions: [...me.permissions, 'infrastructure:read'] })
      : path.includes('sign-out') ? response({}) : pending.promise;
  });
  const load = model.load({ view: 'infrastructure', limit: '25', q: 'old-user-query' });
  await new Promise(r => setImmediate(r));
  assert.equal(calls[1], '/api/admin/infrastructure');
  await model.signOut();
  pending.resolve(response({ items: [], observedAt: new Date().toISOString(), staleAfterSeconds: 90, truncated: false }));
  await load;
  assert.equal(model.getSnapshot().infrastructure, null);
  assert.equal(model.getSnapshot().phase, 'login');
});

test('infrastructure UI: resource payload kept separate from account rows, cleared when changing view', async () => {
  const payload = { items: [], observedAt: new Date().toISOString(), staleAfterSeconds: 90, truncated: false };
  const model = new AdminSession(async path => response(path === '/api/admin/me'
    ? { ...me, permissions: [...me.permissions, 'infrastructure:read'] } : path.includes('infrastructure') ? payload : { items: [], nextCursor: null }));
  await model.load({ view: 'infrastructure' });
  assert.equal(model.getSnapshot().phase, 'ready');
  assert.deepEqual(model.getSnapshot().infrastructure, payload);
  await model.load({ view: 'users' });
  assert.equal(model.getSnapshot().infrastructure, null);
});

test('admin UI: stalled requests time out and cannot repopulate protected state', async () => {
  const pending = deferred();
  const model = new AdminSession(async () => pending.promise, 20);
  await model.load({ view: 'users' });
  assert.equal(model.getSnapshot().phase, 'error');
  assert.equal(model.getSnapshot().me, null);
  pending.resolve(response(me));
  await new Promise(r => setImmediate(r));
  assert.equal(model.getSnapshot().phase, 'error');
});

test('admin UI: browser fetch is not called with the model as its receiver', async t => {
  t.mock.method(globalThis, 'fetch', async function(path) {
    assert.ok(this === undefined || this === globalThis, 'browser fetch rejects a foreign receiver');
    return response(path === '/api/admin/me' ? me : { items: [], nextCursor: null });
  });
  const model = new AdminSession();
  await model.load({ view: 'users' });
  assert.equal(model.getSnapshot().phase, 'ready');
});

test('admin UI: ordinary users and missing migration fail closed without loading rows', async () => {
  for (const [code, phase] of [[401, 'login'], [403, 'denied'], [503, 'error']]) {
    const calls = [];
    const model = new AdminSession(async path => { calls.push(path); return response({}, code); });
    await model.load({ view: 'users' });
    assert.equal(model.getSnapshot().phase, phase);
    assert.equal(model.getSnapshot().me, null);
    assert.deepEqual(model.getSnapshot().items, []);
    assert.deepEqual(calls, ['/api/admin/me']);
  }
});

test('admin UI: an anonymous visit shows a clean login form, while rejected credentials show an error', async () => {
  const model = new AdminSession(async () => response({}, 401));
  await model.load({ view: 'users' });
  assert.equal(model.getSnapshot().phase, 'login');
  assert.equal(model.getSnapshot().error, '');
  await model.signIn('admin@example.test', 'incorrect-test-password');
  assert.equal(model.getSnapshot().phase, 'login');
  assert.equal(model.getSnapshot().error, '邮箱或密码错误。');
});

test('admin UI: logout clears rows immediately; stale successful response cannot restore access', async () => {
  const pending = deferred();
  const model = new AdminSession(async path => path === '/api/admin/me' ? response(me) : path.includes('sign-out') ? response({}) : pending.promise);
  const load = model.load({ view: 'users' });
  await new Promise(r => setImmediate(r));
  await model.signOut();
  pending.resolve(response({ items: [{ id: 'secret-user' }], nextCursor: null }));
  await load;
  assert.equal(model.getSnapshot().phase, 'login');
  assert.deepEqual(model.getSnapshot().items, []);
});

test('admin UI: old page failure cannot override the newer page', async () => {
  const pending = deferred();
  const model = new AdminSession(async path => path === '/api/admin/me' ? response(me) : path.includes('/users') ? pending.promise : response({ items: [{ id: 'agent-a' }], nextCursor: null }));
  const old = model.load({ view: 'users' });
  await new Promise(r => setImmediate(r));
  await model.load({ view: 'agents', ownerUserId: 'user-a' });
  pending.resolve(response({}, 403));
  await old;
  assert.equal(model.getSnapshot().phase, 'ready');
  assert.equal(model.getSnapshot().items[0].id, 'agent-a');
});

test('admin UI: failed logout remains locked and reports failure, retry revokes session', async () => {
  let fail = true;
  const model = new AdminSession(async path => path.includes('sign-out') ? response({}, fail ? 503 : 200) : response(me));
  await model.signOut();
  assert.equal(model.getSnapshot().phase, 'logout-error');
  await model.load({ view: 'users' });
  assert.equal(model.getSnapshot().phase, 'logout-error');
  fail = false;
  await model.signOut();
  assert.equal(model.getSnapshot().phase, 'login');
});

test('admin UI: effect cleanup cannot abort the pending server logout', async () => {
  const pending = deferred();
  let signal;
  const model = new AdminSession(async (_path, options) => { signal = options.signal; return pending.promise; });
  const logout = model.signOut();
  model.cancel();
  await model.load({ view: 'users' });
  assert.equal(signal.aborted, false);
  assert.equal(model.getSnapshot().phase, 'signing-out');
  pending.resolve(response({}));
  await logout;
  assert.equal(model.getSnapshot().phase, 'login');
  assert.deepEqual(model.getSnapshot().items, []);
});

test('admin UI: sign-in uses existing Better Auth only, no role/header/local credential storage', async () => {
  const calls = [];
  const model = new AdminSession(async (path, options) => {
    calls.push({ path, options });
    return response(path.includes('/me') ? me : path.includes('/users') ? { items: [], nextCursor: null } : {});
  });
  await model.signIn('admin@example.test', 'test-password');
  assert.equal(model.getSnapshot().phase, 'ready');
  assert.equal(calls[0].path, '/api/auth/sign-in/email');
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: 'admin@example.test', password: 'test-password' });
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers['x-platform-role'], undefined);
});
