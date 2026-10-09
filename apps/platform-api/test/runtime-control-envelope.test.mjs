import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ControlEnvelopeError,
  MemoryNonceStore,
  signControlRequest,
  signControlResponse,
  verifyControlRequest,
  verifyControlResponse,
} from '../src/runtime/control-envelope.mjs';

const secret = 'runtime-control-test-secret-at-least-32-characters';
const alternateSecret = 'runtime-control-rotated-secret-at-least-32-chars';
const requestId = '00000000-0000-4000-8000-000000000001';
const now = Date.parse('2026-10-08T00:00:00.000Z');
const body = JSON.stringify({ agentId: 'agent-1', runId: 'run-1', runGeneration: 1 });

function signedRequest(overrides = {}) {
  return signControlRequest({
    method: 'PUT',
    path: '/v1/runs/run-1?mode=strict',
    body,
    requestId,
    keyId: 'primary',
    secret,
    now,
    nonce: 'nonce-1',
    ...overrides,
  });
}

function verifyRequest(headers, overrides = {}) {
  return verifyControlRequest({
    method: 'PUT',
    path: '/v1/runs/run-1?mode=strict',
    body,
    headers,
    keys: { primary: secret, rotated: alternateSecret },
    now: now + 100,
    nonceStore: new MemoryNonceStore(),
    ...overrides,
  });
}

test('runtime control envelope: signed request binds method, path, request id and body', () => {
  const headers = signedRequest();
  const verified = verifyRequest(headers);
  assert.equal(verified.keyId, 'primary');
  assert.equal(verified.requestId, requestId);
  for (const changed of [
    { method: 'POST' },
    { path: '/v1/runs/run-2?mode=strict' },
    { body: body + ' ' },
  ]) {
    assert.throws(
      () => verifyRequest(headers, changed),
      (error) => error instanceof ControlEnvelopeError && error.code === 'control_signature_invalid',
    );
  }
});

test('runtime control envelope: timestamp is bounded and nonce replay is rejected', () => {
  const headers = signedRequest();
  const nonceStore = new MemoryNonceStore();
  assert.equal(verifyRequest(headers, { nonceStore }).requestId, requestId);
  assert.throws(
    () => verifyRequest(headers, { nonceStore }),
    (error) => error instanceof ControlEnvelopeError && error.code === 'control_nonce_replayed',
  );
  assert.throws(
    () => verifyRequest(headers, { now: now + 60_001 }),
    (error) => error instanceof ControlEnvelopeError && error.code === 'control_signature_expired',
  );
});

test('runtime control envelope: tampered signatures do not consume the nonce', () => {
  const headers = signedRequest();
  const nonceStore = new MemoryNonceStore();
  const tampered = { ...headers, 'x-bairui-control-signature': '0'.repeat(64) };
  assert.throws(() => verifyRequest(tampered, { nonceStore }), { message: 'control_signature_invalid' });
  assert.equal(verifyRequest(headers, { nonceStore }).requestId, requestId);
});

test('runtime control envelope: key ids support rotation and unknown keys fail closed', () => {
  const rotated = signedRequest({ keyId: 'rotated', secret: alternateSecret, nonce: 'nonce-rotated' });
  assert.equal(verifyRequest(rotated).keyId, 'rotated');
  const unknown = signedRequest({ keyId: 'unknown', secret: alternateSecret, nonce: 'nonce-unknown' });
  assert.throws(() => verifyRequest(unknown), { message: 'control_key_unknown' });
});

test('runtime control envelope: response signature binds status, request id and body', () => {
  const responseBody = JSON.stringify({ agentId: 'agent-1', runId: 'run-1', runGeneration: 1, status: 'running' });
  const headers = signControlResponse({ status: 200, requestId, requestNonce: 'nonce-1', body: responseBody, keyId: 'primary', secret });
  assert.equal(verifyControlResponse({ status: 200, requestId, requestNonce: 'nonce-1', body: responseBody, headers, keys: { primary: secret } }).keyId, 'primary');
  for (const changed of [
    { status: 202 },
    { requestId: '00000000-0000-4000-8000-000000000002' },
    { body: responseBody + ' ' },
  ]) {
    assert.throws(
      () => verifyControlResponse({ status: 200, requestId, requestNonce: 'nonce-1', body: responseBody, headers, keys: { primary: secret }, ...changed }),
      (error) => error instanceof ControlEnvelopeError
        && ['control_response_mismatch', 'control_signature_invalid'].includes(error.code),
    );
  }
});

test('runtime control envelope: weak secrets and malformed metadata are rejected', () => {
  assert.throws(() => signedRequest({ secret: 'short' }), { message: 'control_secret_invalid' });
  const headers = signedRequest();
  assert.throws(() => verifyRequest({ ...headers, 'x-bairui-control-version': 'v2' }), { message: 'control_version_invalid' });
  assert.throws(() => verifyRequest({ ...headers, 'x-bairui-control-request-id': 'not-a-uuid' }), { message: 'control_request_id_invalid' });
  assert.throws(() => verifyRequest({ ...headers, 'x-bairui-control-signature': 'not-hex' }), { message: 'control_signature_invalid' });
});

test('response from an earlier retry cannot confirm a later request with the same requestId', () => {
  const headers = signControlResponse({ status: 200, requestId, requestNonce: 'first-attempt', body, keyId: 'primary', secret });
  assert.throws(() => verifyControlResponse({ status: 200, requestId, requestNonce: 'second-attempt', body, headers, keys: { primary: secret } }), /control_response_mismatch/);
});

test('nonce consumption requires an explicit true result, not a pending Promise', () => {
  assert.throws(() => verifyRequest(signedRequest(), { nonceStore: { consume: () => Promise.resolve(false) } }), /control_nonce_replayed/);
});
