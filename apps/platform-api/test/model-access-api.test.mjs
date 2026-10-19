import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { createApp } from '../src/app.mjs';
import { modelFixture, providerKey } from './helpers/model-access-fixture.mjs';
import { routeLabel } from '../src/observability/labels.mjs';

const base = '/api/user/model-credentials';
async function incompleteBody(t, app, body, holdOpen = false) {
  const closed = new Promise(resolve => app.once('connection', serverSocket => serverSocket.once('close', resolve)));
  const socket = connect({ port: app.address().port, host: '127.0.0.1', allowHalfOpen: holdOpen });
  t.after(() => socket.destroy());
  let raw = '';
  await new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('data', chunk => { raw += chunk.toString(); if (raw.includes('\r\n\r\n')) resolve(); });
    socket.once('connect', () => socket.write('POST ' + base + ' HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\nX-Test-User: user-a\r\nOrigin: http://console.example:8080\r\nContent-Type: application/json\r\nContent-Length: 100000000\r\n\r\n' + body));
  });
  assert.match(raw, /\r\nconnection: close\r\n/i);
  let timer;
  try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('server did not close rejected incomplete body socket')), 1500); })]); }
  finally { clearTimeout(timer); }
  return raw;
}
async function fixture(t, { enabled = true, overrides = {}, extra = {} } = {}) {
  const f = await modelFixture();
  f.platform.platformRoles = new Map([['user-b', { role: 'platform_admin' }]]);
  const env = { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: 'http://console.example:8080/auth', ...(enabled ? { BAIRUI_MODEL_CREDENTIALS_ENABLED: '1' } : {}), ...overrides };
  const configuration = { keyId: f.configuration.keyId, publicKeyPem: f.configuration.publicKey.export({ type: 'spki', format: 'pem' }), providers: f.configuration.providers };
  const auth = { provider: 'better-auth', async resolve(req) { const user = f.platform.findUser(req.headers['x-test-user']); return user && { userId: user.id, organizationId: user.organizationId }; } };
  const app = createApp({ env, store: f.platform, auth, ...(enabled ? { modelCredentials: { store: f.store, configuration } } : {}), ...extra });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { app.closeAllConnections(); app.close(r); }));
  const request = (path = base, { method = 'GET', body, actor = 'user-a', headers = {} } = {}) => fetch('http://127.0.0.1:' + app.address().port + path, { method, headers: { ...(actor ? { 'x-test-user': actor } : {}), origin: 'http://console.example:8080', 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const create = (input = {}, options = {}) => request(base, { method: 'POST', body: { provider: 'provider-a', label: 'Saved key', apiKey: providerKey, ...input }, ...options });
  return { ...f, configuration, env, app, request, create };
}

test('credential API defaults off with no configuration I/O and no-store even for anonymous requests', async t => {
  const { request } = await fixture(t, { enabled: false, overrides: { BAIRUI_MODEL_CREDENTIALS_CONFIG_FILE: 'Z:/nonexistent/private-key-file' } });
  for (const actor of ['user-a', null]) for (const path of [base, base + '/' + randomUUID(), base + '/grants']) {
    const response = await request(path, { actor });
    assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('credential API creates, lists, rotates and revokes only metadata without opening agent execution', async t => {
  const { create, request, app, store } = await fixture(t);
  const created = await create(); assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const { credential } = await created.json();
  assert.deepEqual(Object.keys(credential).sort(), ['id', 'provider', 'label', 'version', 'status', 'createdAt', 'updatedAt'].sort());
  assert.equal(credential.version, 1);
  const list = await request(); assert.equal(list.status, 200);
  assert.equal((await list.json()).credentials.length, 2);
  const path = base + '/' + credential.id;
  const rotated = await request(path, { method: 'PUT', body: { apiKey: providerKey + '-next', expectedVersion: 1 } });
  assert.equal(rotated.status, 200); assert.equal((await rotated.json()).credential.version, 2);
  assert.equal((await request(path, { method: 'DELETE', body: { expectedVersion: 1 } })).status, 409);
  const revoked = await request(path, { method: 'DELETE', body: { expectedVersion: 2 } });
  assert.equal(revoked.status, 200); assert.equal((await revoked.json()).credential.status, 'revoked');
  assert.equal(store.grants.size, 1);
  const capabilities = (await (await request('/api/auth/config')).json()).capabilities;
  assert.deepEqual(capabilities, { mode: 'platform', agentLifecycle: false, agentExecution: false, simulatedRecharge: false });
  assert.equal(app.platform.runtime, null);
  assert.equal((await request('/api/user/agents', { method: 'POST', body: '{}' })).status, 403);
  for (const path of [base + '/grants', base + '/decrypt', base + '/proxy', base + '/' + credential.id + '/grant']) assert.equal((await request(path, { method: 'POST', body: '{}' })).status, 404);
});

test('credential API requires a session and never permits platform admins to cross ownership', async t => {
  const { request, credential, create } = await fixture(t);
  const anonymous = await request(base, { actor: null }); assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await (await request(base, { actor: 'user-b' })).json()).credentials, []);
  for (const method of ['PUT', 'DELETE']) {
    const result = await request(base + '/' + credential.id, { actor: 'user-b', method, body: method === 'PUT' ? { apiKey: providerKey, expectedVersion: 1 } : { expectedVersion: 1 } });
    assert.equal(result.status, 404); assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await create({ organizationId: 'org-b', userId: 'user-b' })).status, 422);
});

test('credential API permits suspended metadata reads, rejects writes, and rejects banned sessions', async t => {
  const { request, create, platform } = await fixture(t);
  platform.accountGovernance = new Map([['user-a', { status: 'suspended', version: 1 }]]);
  assert.equal((await request()).status, 200); assert.equal((await create()).status, 403);
  platform.accountGovernance.set('user-a', { status: 'banned', version: 2 });
  const banned = await request(); assert.equal(banned.status, 401); assert.equal(banned.headers.get('cache-control'), 'no-store');
});

test('credential API enforces configured origin, JSON body limits, strict fields and provider allowlist', async t => {
  const { request, create, credential } = await fixture(t);
  for (const origin of ['', 'null', 'https://other.test', 'http://127.0.0.1']) assert.equal((await create({}, { headers: { origin, host: 'other.test', 'x-forwarded-host': 'other.test' } })).status, 403);
  for (const contentType of ['', 'text/plain']) assert.equal((await create({}, { headers: { 'content-type': contentType } })).status, 415);
  assert.equal((await create({}, { headers: { 'content-encoding': 'gzip' } })).status, 415);
  for (const input of [{ provider: 'other' }, { extra: true }, { apiKey: 'x'.repeat(4097) }]) assert.equal((await create(input)).status, 422);
  assert.equal((await request(base, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await request(base, { method: 'POST', body: ' '.repeat(16385) })).status, 413);
  assert.equal((await request(base + '?userId=user-b')).status, 422);
  assert.equal((await request(base + '/invalid-id', { method: 'DELETE', body: { expectedVersion: 1 } })).status, 404);
  assert.equal((await request(base + '/' + credential.id, { method: 'DELETE', body: { expectedVersion: 1, token: 'forbidden' } })).status, 422);
  assert.equal((await request(base + '/' + credential.id, { method: 'PUT', body: { expectedVersion: 1, apiKey: providerKey, provider: 'other' } })).status, 422);
});

test('credential API sanitizes database and cryptographic failures and filters accidental extra fields', async t => {
  const { request, create, store } = await fixture(t);
  store.listCredentials = async () => { throw new Error('postgres://private:password@internal secret raw SQL'); };
  const unavailable = await request(); assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'model_access_unavailable');
  store.listCredentials = async () => [{ id: randomUUID(), provider: 'provider-a', label: 'safe', version: 1, status: 'active', createdAt: 'time', updatedAt: 'time', envelope: { ciphertext: 'secret' }, apiKey: providerKey, grantToken: 'token' }];
  const text = await (await request()).text();
  assert.equal(/ciphertext|apiKey|grantToken|fixture-provider/.test(text), false);
  store.createCredential = async () => { throw new Error('RSA private internals'); };
  const failed = await create(); assert.equal(failed.status, 503); assert.equal((await failed.json()).error.message, 'model_access_unavailable');
});

test('credential startup rejects non-test injection and opt-in without explicit valid configuration', () => {
  assert.throws(() => createApp({ env: { NODE_ENV: 'development', BAIRUI_PLATFORM_MODE: 'legacy' }, modelCredentials: {} }), /model_access_configuration_invalid/);
  assert.throws(() => createApp({ env: { NODE_ENV: 'test', BAIRUI_MODEL_CREDENTIALS_ENABLED: '1' }, store: {} }), /model_access_configuration_invalid/);
  assert.throws(() => createApp({ env: { NODE_ENV: 'test', BAIRUI_MODEL_CREDENTIALS_ENABLED: 'invalid' }, store: {} }), /model_access_configuration_invalid/);
});

test('credential metric labels have a fixed route for base and arbitrary IDs', () => {
  assert.equal(routeLabel(base), base);
  assert.equal(routeLabel(base + '/private-id?secret=hidden'), base + '/:credentialId');
});

test('credential API bounds database response time and keeps concurrency occupied until work settles', async t => {
  const { request, store } = await fixture(t);
  const resolvers = []; let admitted;
  const full = new Promise(resolve => { admitted = resolve; });
  store.listCredentials = () => new Promise(resolve => { resolvers.push(resolve); if (resolvers.length === 16) admitted(); });
  const pending = Array.from({ length: 16 }, () => request());
  await full;
  const busy = await request(); assert.equal(busy.status, 429); assert.equal(busy.headers.get('cache-control'), 'no-store');
  for (const response of await Promise.all(pending)) { assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'model_access_unavailable'); }
  assert.equal((await request()).status, 429);
  resolvers.forEach(resolve => resolve([]));
  store.listCredentials = async () => [];
  assert.equal((await request()).status, 200);
});

test('credential API bounds slow request bodies and does not execute timed-out writes', async t => {
  const { app, store } = await fixture(t);
  const before = store.credentials.size;
  const raw = await incompleteBody(t, app, '{', true);
  assert.match(raw, /^HTTP\/1.1 408 /); assert.match(raw, /cache-control: no-store/i);
  assert.match(raw, /"code":"request_timeout"/); assert.equal(store.credentials.size, before);
});

test('credential API closes oversized incomplete body sockets after flushing the 413 response', async t => {
  const { app, store, request } = await fixture(t);
  const before = store.credentials.size;
  for (let i = 0; i < 17; i++) {
    const raw = await incompleteBody(t, app, 'x'.repeat(8193), i === 0);
    assert.match(raw, /^HTTP\/1.1 413 /); assert.match(raw, /cache-control: no-store/i);
    assert.match(raw, /"code":"payload_too_large"/);
  }
  assert.equal(store.credentials.size, before);
  assert.equal((await request()).status, 200);
});
