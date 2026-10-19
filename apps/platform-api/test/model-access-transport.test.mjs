import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpsRequest } from 'node:https';
import { tlsFixture, successStream } from './helpers/model-access-fixture.mjs';
let api = {};
try { api = await import('../src/model-access/transport.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }

test('provider transport rejects reserved, private, mapped and transition addresses', () => {
  assert.equal(typeof api.isPublicModelAddress, 'function');
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.100.100.200', '169.254.169.254', '172.31.255.255', '192.168.1.1', '192.0.0.9', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2001:db8::1', '2002:808:808::', 'fc00::1', 'fe80::1', 'ff02::1', '3fff::1', 'not-an-ip']) assert.equal(api.isPublicModelAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(api.isPublicModelAddress(ip), true, ip);
});

test('every resolved address must pass before any network side effect', async () => {
  assert.equal(typeof api.createProviderTransport, 'function');
  let called = false;
  const transport = api.createProviderTransport({ resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], request: () => { called = true; } });
  await assert.rejects(transport({ provider: { baseUrl: 'https://model.example/v1' }, apiKey: 'fixture-only-provider-key', payload: {}, signal: new AbortController().signal }), { code: 'model_upstream_unavailable' });
  assert.equal(called, false);
});

test('cloud platform virtual service address is not a public model destination', () => {
  assert.equal(api.isPublicModelAddress('168.63.129.16'), false);
});

test('DNS deadline is covered by cancellation, without falling back or opening a connection', async () => {
  assert.equal(typeof api.createProviderTransport, 'function');
  const controller = new AbortController();
  const transport = api.createProviderTransport({ resolve: () => new Promise(() => {}), request: () => { throw new Error('must not connect'); } });
  const pending = transport({ provider: { baseUrl: 'https://model.example/v1' }, apiKey: 'fixture-only-provider-key', payload: {}, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: 'model_upstream_unavailable' });
});

test('real HTTPS uses the checked DNS pin and original TLS authority, fixed headers and no redirect', async t => {
  const tls = await tlsFixture(t); let redirects = false, calls = 0, resolveCalls = 0, captured, received;
  const server = createServer(tls, async (req, res) => {
    calls++; received = { headers: req.headers, path: req.url }; let body = '';
    for await (const bytes of req) body += bytes; received.body = JSON.parse(body);
    res.writeHead(redirects ? 302 : 200, { 'content-type': 'text/event-stream', location: 'https://other.example/v1' }); res.end(redirects ? 'raw-error-canary' : successStream);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const transport = api.createProviderTransport({ resolve: async () => { resolveCalls++; return [{ address: '8.8.8.8', family: 4 }]; }, request: (options, callback) => {
    captured = options;
    return httpsRequest({ ...options, port: server.address().port, ca: tls.cert, lookup: (_h, _o, cb) => cb(null, '127.0.0.1', 4) }, callback);
  } });
  const call = { provider: { baseUrl: 'https://model.example/v1' }, apiKey: 'fixture-only-provider-key', payload: { model: 'model-a' }, signal: new AbortController().signal };
  const response = await transport(call); let raw = ''; for await (const bytes of response) raw += bytes;
  assert.match(raw, /\[DONE\]/); assert.equal(captured.servername, 'model.example'); assert.equal(captured.rejectUnauthorized, true); assert.equal(captured.agent, false); assert.deepEqual(captured.proxyEnv, {});
  captured.lookup('model.example', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
  assert.equal(received.path, '/v1/chat/completions'); assert.equal(received.headers.authorization, 'Bearer ' + call.apiKey); assert.equal(received.headers.cookie, undefined); assert.equal(received.headers.host, 'model.example:' + server.address().port);
  redirects = true; await assert.rejects(transport(call), { code: 'model_upstream_unavailable' });
  assert.equal(calls, 2); assert.equal(resolveCalls, 2);
});
