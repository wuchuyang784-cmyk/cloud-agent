import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';
import { betterAuthOptions } from '../src/auth/better-auth-resolver.mjs';

const env = { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: 'http://localhost:8080',
  BETTER_AUTH_SECRET: 'test-only-secret-with-at-least-32-characters' };

async function listen(t, options) {
  const app = createApp({ env: { NODE_ENV: 'test' }, ...options });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  return 'http://127.0.0.1:' + app.address().port;
}

test('unexpected errors use a structured allowlist and replace untrusted request IDs', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const base = await listen(t, { store: new MemoryStore(), auth: { resolve: async () => {
    throw Object.assign(new Error('private-password private@example.test SELECT private_sql'), { code: 'private-code', detail: 'private-detail' });
  } } });
  const response = await fetch(base + '/private-id?token=private-query', {
    headers: { 'x-request-id': 'private-header@example.test', authorization: 'Bearer private-bearer', cookie: 'private-cookie' },
  });
  assert.equal(response.status, 500);
  assert.match(response.headers.get('x-request-id'), /^req_[a-f0-9-]{36}$/);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].length, 1);
  assert.equal(typeof logs[0][0], 'string');
  const record = JSON.parse(logs[0][0]);
  assert.deepEqual(Object.keys(record).sort(), ['event', 'level', 'method', 'requestId', 'route', 'status', 'timestamp']);
  assert.equal(record.event, 'http_request_error');
  assert.equal(record.requestId, response.headers.get('x-request-id'));
  assert.equal(record.route, 'unmatched');
  assert.equal(record.status, '500');
  assert.doesNotMatch(JSON.stringify(logs), /private|SELECT/);
  assert.doesNotMatch(await response.text(), /private/);
});

test('even syntactically valid client request IDs are never echoed or logged', async t => {
  const base = await listen(t, { store: new MemoryStore(), auth: { resolve: async () => null } });
  for (const requestId of ['req_12345678-1234-4123-a123-123456789abc', 'secret'.repeat(500)]) {
    const response = await fetch(base + '/api/auth/me', { headers: { 'x-request-id': requestId } });
    assert.equal(response.status, 401);
    assert.notEqual(response.headers.get('x-request-id'), requestId);
    assert.match(response.headers.get('x-request-id'), /^req_[a-f0-9-]{36}$/);
  }
});

test('Better Auth logger discards payloads and routes unexpected errors to the safe API catch', t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  const options = betterAuthOptions(env, undefined);
  assert.equal(typeof options.logger?.log, 'function');
  assert.equal(options.onAPIError?.throw, true);
  options.logger.log('error', 'private@example.test', new Error('private-credentials'), { password: 'private-password' });
  options.logger.log('warn', 'private-warning');
  assert.equal(logs.length, 2);
  assert.doesNotMatch(JSON.stringify(logs), /private|SELECT/);
  for (const args of logs) {
    assert.equal(args.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(args[0])).sort(), ['event', 'level', 'timestamp']);
  }
});

test('real Better Auth failing adapter cannot leak SQL, email or credentials to console', async t => {
  const logs = [];
  for (const method of ['error', 'warn', 'log']) t.mock.method(console, method, (...args) => logs.push(args));
  const database = { ba_user: [], ba_session: [], ba_account: [], ba_verification: [], ba_rate_limit: [] };
  const adapter = memoryAdapter(database);
  const base = await listen(t, { env, store: new MemoryStore(), authOptions: { betterAuthDatabase: config => {
    const instance = adapter(config);
    return { ...instance, findOne: async () => { throw new Error('SELECT private_sql password=private-password email=private@example.test'); } };
  } } });
  const response = await fetch(base + '/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: env.BETTER_AUTH_URL },
    body: JSON.stringify({ email: 'private@example.test', password: 'private-password' }),
  });
  assert.equal(response.status, 500);
  assert.ok(logs.length > 0);
  assert.doesNotMatch(JSON.stringify(logs), /private|SELECT/);
  for (const args of logs) assert.doesNotThrow(() => JSON.parse(args[0]));
});
