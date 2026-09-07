import test from 'node:test';
import assert from 'node:assert/strict';

import { signRequest, envelopeHeaders, verifyEnvelope } from '../src/runtime/boundary-envelope.mjs';
import { createBoundaryServer } from '../src/runtime/boundary-server.mjs';

const SECRET = 'boundary-test-secret';
const BODY = JSON.stringify({
  organizationId: 'dev-org',
  agentId: 'agent-test',
  userId: 'dev-user',
  role: 'user',
  operation: 'provision',
  traceId: 'trace-1',
  createdAt: Date.now(),
  engine: 'dsh',
});

function verify({ secret = SECRET, body = BODY, env, seenNonces = null, now } = {}) {
  return verifyEnvelope({
    secret,
    body,
    timestamp: env.timestamp,
    nonce: env.nonce,
    signature: env.signature,
    seenNonces,
    now,
  });
}

test('signRequest + verifyEnvelope 正常通过', () => {
  const env = signRequest({ secret: SECRET, body: BODY });
  assert.equal(verify({ env }).ok, true);
});

test('envelopeHeaders 输出 x-bairui-* 三个头字段', () => {
  const headers = envelopeHeaders({ secret: SECRET, body: BODY });
  assert.ok(headers['x-bairui-timestamp']);
  assert.ok(headers['x-bairui-nonce']);
  assert.ok(headers['x-bairui-signature']);
});

test('body 被篡改 → invalid_signature', () => {
  const env = signRequest({ secret: SECRET, body: 'hello' });
  assert.deepEqual(verify({ body: 'tampered', env }), { ok: false, error: 'invalid_signature' });
});

test('错误密钥 → invalid_signature', () => {
  const env = signRequest({ secret: 'other-secret', body: BODY });
  assert.deepEqual(verify({ secret: SECRET, env }), { ok: false, error: 'invalid_signature' });
});

test('过期时间戳 → stale_timestamp', () => {
  const old = Date.now() - 10 * 60 * 1000;
  const env = signRequest({ secret: SECRET, body: BODY, now: old });
  assert.deepEqual(verify({ env, now: Date.now() }), { ok: false, error: 'stale_timestamp' });
});

test('nonce 重放 → replayed_nonce', () => {
  const seenNonces = new Set();
  const env = signRequest({ secret: SECRET, body: BODY });
  assert.equal(verify({ env, seenNonces }).ok, true);
  assert.deepEqual(verify({ env, seenNonces }), { ok: false, error: 'replayed_nonce' });
});

test('boundary server：合法信封 accepted，无/错签名 401，healthz 免信封', async () => {
  const server = createBoundaryServer({ secret: SECRET });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const valid = await fetch(base + '/v1/runtime/operations', {
      method: 'POST',
      headers: { ...envelopeHeaders({ secret: SECRET, body: BODY }), 'content-type': 'application/json' },
      body: BODY,
    });
    assert.equal(valid.status, 202);
    const accepted = await valid.json();
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.operation, 'provision');
    assert.equal(accepted.agentId, 'agent-test');

    const noSig = await fetch(base + '/v1/runtime/operations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: BODY,
    });
    assert.equal(noSig.status, 401);

    const wrongKey = await fetch(base + '/v1/runtime/streams', {
      method: 'POST',
      headers: { ...envelopeHeaders({ secret: 'wrong', body: BODY }), 'content-type': 'application/json' },
      body: BODY,
    });
    assert.equal(wrongKey.status, 401);

    const unknownRoute = await fetch(base + '/v1/runtime/foo', {
      method: 'POST',
      headers: { ...envelopeHeaders({ secret: SECRET, body: BODY }), 'content-type': 'application/json' },
      body: BODY,
    });
    assert.equal(unknownRoute.status, 404);

    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'bairui-runtime-boundary');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
