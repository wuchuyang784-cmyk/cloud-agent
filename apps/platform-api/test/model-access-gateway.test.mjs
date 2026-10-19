import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { modelFixture, tlsFixture, providers, providerKey, successStream } from './helpers/model-access-fixture.mjs';
let api = {};
try { api = await import('../src/model-access/gateway.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const input = { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], stream: true };
async function fixture(t, options = {}) {
  assert.equal(typeof api.createModelGateway, 'function');
  const f = await modelFixture(), tls = await tlsFixture(t), calls = [];
  const gateway = api.createModelGateway({ ...f, providers, transport: async call => { calls.push(call); return Readable.from([Buffer.from(successStream)]); }, ...options });
  const server = createServer(tls, gateway.handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await gateway.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const send = (payload = input, options = {}) => new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port: server.address().port, path: '/v1/chat/completions', method: 'POST', ca: tls.cert, ...options,
      headers: { authorization: 'Bearer ' + f.grant.token, 'content-type': 'application/json', ...options.headers } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw })); res.on('error', reject);
    }); req.on('error', reject); req.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
  return { ...f, gateway, calls, send, server, tls };
}

test('real TLS gateway replaces runtime bearer with provider Key, bounds pi token requests and records reported usage', async t => {
  const f = await fixture(t);
  const response = await f.send({ ...input, max_completion_tokens: 16384, stream_options: { include_usage: false } }, { headers: { cookie: 'not-forwarded=secret' } });
  assert.equal(response.status, 200); assert.equal(response.headers['cache-control'], 'no-store'); assert.match(response.raw, /\[DONE\]/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].apiKey, providerKey); assert.equal(f.calls[0].payload.max_completion_tokens, 4096);
  assert.equal(f.calls[0].payload.stream_options.include_usage, true); assert.equal(f.calls[0].headers, undefined);
  assert.doesNotMatch(response.raw, new RegExp(providerKey + '|' + f.grant.token));
  const receipt = [...f.store.requests.values()][0]; assert.equal(receipt.state, 'completed'); assert.equal(receipt.inputTokens, 10); assert.equal(receipt.outputTokens, 5);
});

test('gateway rejects wrong bearer/path/model/schema before calling a provider', async t => {
  const f = await fixture(t);
  for (const [payload, options, status] of [[input, { headers: { authorization: 'Bearer invalid' } }, 401], [input, { path: '/v1/chat/completions?url=bad' }, 404], [{ ...input, model: 'other' }, {}, 401], [{ ...input, url: 'https://evil.test/v1' }, {}, 422], [{ ...input, stream: false }, {}, 422], [input, { headers: { origin: 'https://evil.test' } }, 403], ['{bad', {}, 422]]) {
    const response = await f.send(payload, options); assert.equal(response.status, status); assert.doesNotMatch(response.raw, /evil\.test|ciphertext/);
  }
  assert.equal(f.calls.length, 0);
});

test('gateway fails closed after stop, credential rotation or governance change', async t => {
  for (const invalidate of [f => { f.runtime.controls.get('agent-a').desiredState = 'stopped'; }, f => f.service.rotate({ organizationId: 'org-a', userId: 'user-a' }, f.credential.id, { expectedVersion: 1, apiKey: 'rotated-fixture-' + 'z'.repeat(30) }), f => { f.platform.accountGovernance = new Map([['user-a', { status: 'suspended', version: 1 }]]); }]) {
    const f = await fixture(t); await invalidate(f); assert.equal((await f.send()).status, 401); assert.equal(f.calls.length, 0);
  }
});

test('upstream failure is sanitized, consumes one request and is not retried', async t => {
  let calls = 0;
  const f = await fixture(t, { transport: async () => { calls++; throw new Error('raw provider failure ' + providerKey); } });
  const response = await f.send(); assert.equal(response.status, 502); assert.doesNotMatch(response.raw, /raw provider|fixture-provider/); assert.equal(calls, 1);
  assert.equal([...f.store.grants.values()][0].usedRequests, 1); assert.equal([...f.store.requests.values()][0].state, 'unknown');
});

test('request body and total deadline are bounded and shutdown refuses new admission', async t => {
  const f = await fixture(t, { limits: { maxBodyBytes: 100, timeoutMs: 100 } });
  assert.equal((await f.send({ ...input, messages: [{ role: 'user', content: 'x'.repeat(200) }] })).status, 413);
  await f.gateway.shutdown(); assert.equal((await f.send()).status, 503); assert.equal(f.calls.length, 0);
});

test('total deadline cancels a pending upstream once and leaves unknown usage', async t => {
  let calls = 0;
  const f = await fixture(t, { limits: { timeoutMs: 100 }, transport: async ({ signal }) => new Promise((_resolve, reject) => {
    calls++; signal.addEventListener('abort', () => reject(new Error('cancelled fixture secret')), { once: true });
  }) });
  const result = await f.send(); assert.equal(result.status, 504); assert.equal(calls, 1); assert.doesNotMatch(result.raw, /cancelled fixture|\[DONE\]/);
  assert.equal([...f.store.requests.values()][0].state, 'unknown'); assert.equal([...f.store.requests.values()][0].inputTokens, null);
});

test('shutdown aborts partial inbound bodies without waiting for the full request deadline', async t => {
  const f = await fixture(t, { limits: { timeoutMs: 1500 } });
  const arrived = new Promise(resolve => f.server.once('request', request => request.once('data', () => setImmediate(resolve))));
  const req = httpsRequest({ hostname: '127.0.0.1', port: f.server.address().port, path: '/v1/chat/completions', method: 'POST', ca: f.tls.cert,
    headers: { authorization: 'Bearer ' + f.grant.token, 'content-type': 'application/json' } });
  req.on('error', () => {}); req.write('{'); await arrived;
  const started = performance.now(); await f.gateway.shutdown(); req.destroy();
  assert.ok(performance.now() - started < 500); assert.equal(f.calls.length, 0);
});

test('concurrency is bounded before another admission or provider request', async t => {
  let release, started, calls = 0;
  const ready = new Promise(resolve => { started = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { limits: { maxConcurrent: 1 }, transport: async () => { calls++; started(); await blocked; return Readable.from([Buffer.from(successStream)]); } });
  const first = f.send(); await ready;
  try { assert.equal((await f.send()).status, 429); assert.equal(calls, 1); assert.equal(f.store.requests.size, 1); }
  finally { release(); }
  assert.equal((await first).status, 200);
});

test('client disconnect aborts the upstream stream and records unknown without automatic retry', async t => {
  let upstream, calls = 0;
  const f = await fixture(t, { transport: async () => {
    calls++; let sent = false;
    upstream = new Readable({ read() { if (!sent) { sent = true; this.push(Buffer.from('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"model-a","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n')); } } });
    return upstream;
  } });
  await new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: '127.0.0.1', port: f.server.address().port, path: '/v1/chat/completions', method: 'POST', ca: f.tls.cert,
      headers: { authorization: 'Bearer ' + f.grant.token, 'content-type': 'application/json' } }, response => {
      response.on('error', () => {}); response.once('data', () => { upstream.once('close', resolve); request.destroy(); });
    }); request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); }); request.end(JSON.stringify(input));
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal([...f.store.requests.values()][0].state, 'unknown');
});
