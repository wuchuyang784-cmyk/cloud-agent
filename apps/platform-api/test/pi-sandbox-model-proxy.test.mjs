import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { modelFixture, tlsFixture, providers, scope, providerKey, modelChunk, modelEvent, successStream } from './helpers/model-access-fixture.mjs';
import { createModelGateway } from '../src/model-access/gateway.mjs';

let createSandboxModelProxy;
try { ({ createSandboxModelProxy } = await import('../src/runtime/pi/sandbox/model-proxy.mjs')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const token = randomBytes(32).toString('base64url');
const input = { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], stream: true };
const trustedConfig = () => ({ gatewayUrl: 'https://localhost/v1', model: input.model, token });
const fixedConfigError = error => error instanceof Error && error.message === 'Invalid sandbox model proxy configuration' && !String(error.stack).includes('PRIVATE_CONFIG_MARKER');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const connections = server => new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (await predicate()) return; await delay(10); } assert.fail('condition did not settle'); }
function send(server, payload = input, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/v1/chat/completions', method: 'POST', agent: false, ...options,
      headers: { 'content-type': 'application/json; charset=utf-8', ...options.headers } }, res => {
      let raw = ''; res.on('data', bytes => { raw += bytes; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw })); res.on('error', reject);
    });
    req.on('error', reject); req.end(Buffer.isBuffer(payload) || typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}
async function fixture(t, handler, options = {}) {
  assert.equal(typeof createSandboxModelProxy, 'function');
  const tls = await tlsFixture(t), calls = [];
  const upstream = createServer(tls, (req, res) => {
    calls.push({ headers: req.headers, path: req.url });
    if (handler) return handler(req, res, calls);
    let body = ''; req.on('data', bytes => { body += bytes; }); req.on('end', () => { calls.at(-1).payload = JSON.parse(body); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(successStream); });
  });
  await listen(upstream);
  const configuration = { gatewayUrl: `https://127.0.0.1:${upstream.address().port}/v1/chat/completions`, model: input.model, token, ca: tls.cert, ...options };
  const proxy = createSandboxModelProxy(configuration);
  assert.equal(proxy.server.listening, false);
  await listen(proxy.server);
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  return { proxy, upstream, configuration, calls, send: (payload, opts) => send(proxy.server, payload, opts) };
}

test('trusted configuration is exact, HTTPS, fixed path, canonical token and bounded limits', async t => {
  const f = await fixture(t);
  for (const change of [
    { extra: true }, { token: 'bad' }, { token: 'A'.repeat(42) + 'B' }, { model: 'model\n' }, { model: 'bad model' },
    { gatewayUrl: 'http://localhost/v1/chat/completions' }, { gatewayUrl: 'https://u:p@localhost/v1/chat/completions' },
    { gatewayUrl: 'https://localhost/v1/chat/completions?q=1' }, { gatewayUrl: 'https://localhost/v1/chat/completions#x' },
    { gatewayUrl: 'https://localhost/x/../v1/chat/completions' }, { gatewayUrl: 'https://localhost/v1\\chat/completions' },
    { gatewayUrl: 'https://localhost/\nv1/chat/completions' }, { gatewayUrl: 'https://localhost/v1/%2e%2e/chat/completions' },
    { limits: null }, { [Symbol('unknown')]: true }, { limits: { [Symbol('unknown')]: 1 } },
    { limits: { maxBodyBytes: 65537 } }, { limits: { maxConcurrent: 2 } }, { limits: { bodyTimeoutMs: 10001 } },
    { limits: { timeoutMs: 120001 } }, { limits: { maxEventBytes: 262145 } }, { limits: { maxOutputBytes: 4194305 } }, { ca: 42 },
  ]) assert.throws(() => createSandboxModelProxy({ ...f.configuration, ...change }), error => error.message === 'Invalid sandbox model proxy configuration');
  for (const base of ['/v1', '/v1/']) {
    const proxy = createSandboxModelProxy({ ...f.configuration, gatewayUrl: f.configuration.gatewayUrl.replace('/v1/chat/completions', base) });
    await listen(proxy.server); assert.equal((await send(proxy.server)).status, 200); await proxy.close();
  }
});

for (const authority of ['@localhost', ':@localhost']) test(`rejects raw empty userinfo ${authority}`, () => {
  assert.throws(() => createSandboxModelProxy({ ...trustedConfig(), gatewayUrl: `https://${authority}/v1` }), fixedConfigError);
});

test('missing, primitive and incomplete configuration always has the fixed error', () => {
  for (const value of [undefined, null, true, 1, 'PRIVATE_CONFIG_MARKER', [], () => {}, {},
    { model: input.model, token }, { gatewayUrl: 'https://localhost/v1', token }, { gatewayUrl: 'https://localhost/v1', model: input.model }]) {
    assert.throws(() => createSandboxModelProxy(value), fixedConfigError);
  }
});

test('root and limit descriptors reject accessors without executing any getter', () => {
  let executed = 0;
  const accessor = { enumerable: true, get() { executed++; throw new Error('PRIVATE_CONFIG_MARKER'); } };
  const cases = [];
  for (const field of ['gatewayUrl', 'model', 'token', 'ca', 'limits']) {
    const value = trustedConfig(); Object.defineProperty(value, field, accessor); cases.push(value);
  }
  const limits = {}; Object.defineProperty(limits, 'timeoutMs', accessor); cases.push({ ...trustedConfig(), limits });
  const hidden = trustedConfig(); Object.defineProperty(hidden, 'token', { value: token, enumerable: false }); cases.push(hidden);
  const hiddenLimit = {}; Object.defineProperty(hiddenLimit, 'timeoutMs', { value: 100, enumerable: false }); cases.push({ ...trustedConfig(), limits: hiddenLimit });
  for (const value of cases) assert.throws(() => createSandboxModelProxy(value), fixedConfigError);
  assert.equal(executed, 0);
});

test('configuration, limits and CA proxies are refused before any proxy trap executes', () => {
  let executed = 0;
  const trap = () => { executed++; throw new Error('PRIVATE_CONFIG_MARKER'); };
  const handler = { getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, get: trap };
  const revoked = Proxy.revocable(trustedConfig(), handler); revoked.revoke();
  const cases = [new Proxy(trustedConfig(), handler), revoked.proxy,
    { ...trustedConfig(), limits: new Proxy({}, handler) }, { ...trustedConfig(), ca: new Proxy(Buffer.from('CA'), handler) }];
  for (const value of cases) assert.throws(() => createSandboxModelProxy(value), fixedConfigError);
  assert.equal(executed, 0);
});

test('CA Buffers cannot execute own getters while being validated or copied', () => {
  let executed = 0;
  for (const key of ['length', 'buffer', 'byteLength', 'byteOffset', 'valueOf', Symbol.iterator]) {
    const ca = Buffer.from('CA'); Object.defineProperty(ca, key, { get() { executed++; throw new Error('PRIVATE_CONFIG_MARKER'); } });
    assert.throws(() => createSandboxModelProxy({ ...trustedConfig(), ca }), fixedConfigError);
  }
  assert.equal(executed, 0);
});

test('real HTTP to TLS replaces Authorization, drops incoming headers and clamps F2 budget', async t => {
  const f = await fixture(t);
  const response = await f.send({ ...input, max_tokens: 16384 }, { headers: { authorization: 'Bearer pi-placeholder', 'x-user': 'evil', 'x-target-url': 'https://evil.test' } });
  assert.equal(response.status, 200); assert.match(response.raw, /\[DONE\]/); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].headers.authorization, 'Bearer ' + token);
  assert.deepEqual(Object.keys(f.calls[0].headers).sort(), ['authorization', 'connection', 'content-length', 'content-type', 'host']);
  assert.equal(f.calls[0].payload.max_tokens, 4096); assert.equal(f.calls[0].payload.stream_options.include_usage, true);
  assert.equal(f.calls[0].path, '/v1/chat/completions'); assert.ok(!response.raw.includes(token));
});

test('rejects wrong path, browser headers, model, schema, media and invalid UTF8 before HTTPS', async t => {
  const f = await fixture(t);
  for (const [payload, options, status] of [
    [input, { path: '/v1/chat/completions?url=evil' }, 404], [input, { method: 'GET' }, 404],
    [input, { headers: { origin: 'null' } }, 403], [input, { headers: { cookie: '' } }, 403],
    [{ ...input, model: 'other' }, {}, 403], [{ ...input, url: 'https://evil.test' }, {}, 400],
    [{ ...input, stream: false }, {}, 400], ['{', {}, 400], [Buffer.from([0x7b, 0xff]), {}, 400],
    [input, { headers: { 'content-type': 'text/plain' } }, 400], [input, { headers: { 'content-encoding': 'gzip' } }, 400],
  ]) { const response = await f.send(payload, options); assert.equal(response.status, status); assert.ok(!response.raw.includes(token)); }
  assert.equal(f.calls.length, 0);
});

test('oversized complete and 17 partial request bodies flush errors and close all sockets', async t => {
  const f = await fixture(t, undefined, { limits: { maxBodyBytes: 128 } });
  assert.equal((await f.send('x'.repeat(129))).status, 413);
  for (let n = 0; n < 17; n++) await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: f.proxy.server.address().port, path: '/v1/chat/completions', method: 'POST', agent: false, headers: { 'content-type': 'application/json' } }, res => {
      assert.equal(res.statusCode, 413); res.resume(); res.on('end', resolve); res.on('error', reject);
    }); req.on('error', reject); req.write('x'.repeat(129));
  });
  await until(async () => await connections(f.proxy.server) === 0); assert.equal(f.calls.length, 0);
});

test('17 malicious allowHalfOpen peers cannot retain rejected partial-body sockets', async t => {
  const f = await fixture(t, undefined, { limits: { maxBodyBytes: 128 } });
  const clients = [];
  t.after(() => { for (const socket of clients) socket.destroy(); });
  for (let n = 0; n < 17; n++) {
    const socket = connect({ host: '127.0.0.1', port: f.proxy.server.address().port, allowHalfOpen: true }); clients.push(socket);
    const response = await new Promise((resolve, reject) => {
      let raw = ''; socket.on('data', bytes => { raw += bytes; }); socket.once('error', reject); socket.once('end', () => resolve(raw));
      socket.once('connect', () => socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n81\r\n' + 'x'.repeat(129) + '\r\n'));
    });
    assert.match(response, /^HTTP\/1.1 413 /); assert.equal(socket.writableEnded, false);
  }
  await until(async () => await connections(f.proxy.server) === 0); assert.equal(f.calls.length, 0);
});

test('too many headers cannot hide an Origin or Cookie beyond parsed header cap', async t => {
  const f = await fixture(t);
  const headers = Object.fromEntries(Array.from({ length: 40 }, (_, n) => ['x-fill-' + n, 'x']));
  const result = await f.send(input, { headers: { ...headers, origin: 'null', cookie: 'secret' } });
  assert.ok([400, 403, 431].includes(result.status)); assert.equal(f.calls.length, 0);
});

test('fixed CA verification rejects a different certificate without HTTPS request or secrets', async t => {
  const other = await tlsFixture(t); const f = await fixture(t, undefined, { ca: other.cert });
  const result = await f.send(); assert.equal(result.status, 502); assert.doesNotMatch(result.raw, /certificate|self.signed|BEGIN|\[DONE\]/); assert.equal(f.calls.length, 0);
});

for (const [name, status, contentType] of [['redirect', 302, 'text/event-stream'], ['error', 500, 'text/event-stream'], ['non-SSE', 200, 'application/json']]) {
  test(`sanitizes ${name} without following redirect or retrying`, async t => {
    const f = await fixture(t, (_req, res) => { res.writeHead(status, { 'content-type': contentType, location: '/v1/chat/completions', 'x-private': token }); res.end('secret upstream ' + token); });
    const result = await f.send(); assert.equal(result.status, 502); assert.doesNotMatch(result.raw, /secret upstream|\[DONE\]/); assert.ok(!result.raw.includes(token)); assert.equal(result.headers['x-private'], undefined); assert.equal(f.calls.length, 1);
  });
}

test('redacts known grant token split across actual network fragments', async t => {
  const stream = modelEvent(modelChunk({ content: 'prefix ' + token + ' suffix' })) + modelEvent(modelChunk({}, 'stop')) + modelEvent('[DONE]');
  const split = stream.indexOf(token) + 13;
  const f = await fixture(t, async (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(stream.slice(0, split)); await delay(15); if (!res.destroyed) res.end(stream.slice(split)); });
  const result = await f.send(); assert.equal(result.status, 200); assert.match(result.raw, /\[REDACTED\]/); assert.match(result.raw, /\[DONE\]/); assert.ok(!result.raw.includes(token));
});

for (const [name, stream, limits] of [
  ['truncated', modelEvent(modelChunk({ content: 'partial' })), {}],
  ['invalid', 'data: {bad}\n\n', {}],
  ['event bound', modelEvent(modelChunk({ content: 'x'.repeat(300) })), { maxEventBytes: 128 }],
  ['output bound', successStream, { maxOutputBytes: 128 }],
]) test(`${name} stream never receives a success DONE`, async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(stream); }, { limits });
  const result = await f.send(); assert.doesNotMatch(result.raw, /\[DONE\]/); assert.equal(f.calls.length, 1);
});

test('one admission includes slow body, body deadline closes it and permits later work', async t => {
  const f = await fixture(t, undefined, { limits: { bodyTimeoutMs: 80, timeoutMs: 1000 } });
  const arrived = new Promise(resolve => f.proxy.server.once('request', req => req.once('data', resolve)));
  let firstStatus;
  const first = new Promise(resolve => {
    const req = request({ host: '127.0.0.1', port: f.proxy.server.address().port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' }, agent: false }, res => { firstStatus = res.statusCode; res.resume(); res.on('end', resolve); });
    req.on('error', resolve); req.write('{');
  });
  await arrived; assert.equal((await f.send()).status, 429); await first; assert.equal(firstStatus, 504);
  assert.equal((await f.send()).status, 200); assert.equal(f.calls.length, 1);
});

test('total deadline aborts stalled TLS stream without success or retry', async t => {
  let closed = false;
  const f = await fixture(t, (_req, res) => { res.on('close', () => { closed = true; }); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); }, { limits: { timeoutMs: 80 } });
  const result = await f.send(); assert.equal(result.status, 504); assert.doesNotMatch(result.raw, /\[DONE\]/); await until(() => closed); assert.equal(f.calls.length, 1);
});

test('total deadline also bounds waiting for HTTPS response headers', async t => {
  let closed = false;
  const f = await fixture(t, (_req, res) => { res.on('close', () => { closed = true; }); }, { limits: { timeoutMs: 80 } });
  const result = await f.send(); assert.equal(result.status, 504); assert.doesNotMatch(result.raw, /\[DONE\]/); await until(() => closed); assert.equal(f.calls.length, 1);
});

test('client disconnect destroys current TLS request promptly', async t => {
  let closed = false;
  const f = await fixture(t, (_req, res) => { res.on('close', () => { closed = true; }); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(modelEvent(modelChunk({ content: 'partial' }))); });
  await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: f.proxy.server.address().port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, res => { res.on('error', () => {}); res.once('data', () => { req.destroy(); resolve(); }); });
    req.on('error', reject); req.end(JSON.stringify(input));
  });
  await until(() => closed); assert.equal(f.calls.length, 1);
});

test('close is idempotent and promptly aborts incomplete body and existing listener', async t => {
  const f = await fixture(t);
  const arrived = new Promise(resolve => f.proxy.server.once('request', req => req.once('data', resolve)));
  const req = request({ host: '127.0.0.1', port: f.proxy.server.address().port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {}); req.on('response', res => res.resume()); req.write('{'); await arrived;
  const started = performance.now(); await Promise.all([f.proxy.close(), f.proxy.close()]);
  assert.ok(performance.now() - started < 500); assert.equal(f.proxy.server.listening, false); assert.equal(await connections(f.proxy.server), 0); assert.equal(f.calls.length, 0);
});

test('close bounds slow-consumer backpressure and aborts upstream without hanging', async t => {
  let upstreamClosed = false;
  const f = await fixture(t, async (_req, res) => {
    res.on('close', () => { upstreamClosed = true; }); res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = modelEvent(modelChunk({ content: 'x'.repeat(60000) }));
    for (let n = 0; n < 60 && !res.destroyed; n++) { res.write(chunk); await delay(1); }
  });
  let client;
  await new Promise((resolve, reject) => {
    client = request({ host: '127.0.0.1', port: f.proxy.server.address().port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, res => { res.pause(); res.on('error', () => {}); resolve(); });
    client.on('error', () => {}); client.end(JSON.stringify(input)); setTimeout(() => reject(new Error('response missing')), 1000).unref();
  });
  await delay(50); const started = performance.now(); await f.proxy.close(); client.destroy();
  assert.ok(performance.now() - started < 500); await until(() => upstreamClosed); assert.equal(await connections(f.proxy.server), 0);
});

test('closed proxy refuses new work even if its owned server is explicitly rebound', async t => {
  const f = await fixture(t); await f.proxy.close(); await listen(f.proxy.server);
  assert.equal((await f.send()).status, 503); assert.equal(f.calls.length, 0);
  f.proxy.server.closeAllConnections(); await new Promise(resolve => f.proxy.server.close(resolve));
});

test('actual F2 gateway verifies grant and rotation through TLS; only F2 owns receipt', async t => {
  const f2 = await modelFixture(); let providerCalls = 0;
  const gateway = createModelGateway({ ...f2, providers, transport: async ({ apiKey }) => { assert.equal(apiKey, providerKey); providerCalls++; return Readable.from([Buffer.from(successStream)]); } });
  t.after(() => gateway.shutdown());
  const f = await fixture(t, gateway.handler, { token: f2.grant.token });
  assert.equal((await f.send()).status, 200); assert.equal(providerCalls, 1); assert.equal(f2.store.requests.size, 1); assert.equal([...f2.store.requests.values()][0].state, 'completed');
  const wrong = createSandboxModelProxy({ ...f.configuration, token }); await listen(wrong.server); t.after(() => wrong.close());
  assert.equal((await send(wrong.server)).status, 502); assert.equal(providerCalls, 1);
  await f2.service.rotate(scope, f2.credential.id, { expectedVersion: 1, apiKey: 'rotated-fixture-' + 'z'.repeat(30) });
  assert.equal((await f.send()).status, 502); assert.equal(providerCalls, 1); assert.equal(f2.store.requests.size, 1);
});
