import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';
const SIGNATURE_WINDOW_MS = 60_000;
const NONCE_RETENTION_MS = 120_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;
const NONCE_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const METHOD_PATTERN = /^[A-Z]{1,16}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class ControlEnvelopeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ControlEnvelopeError';
    this.code = code;
  }
}

export class MemoryNonceStore {
  constructor() {
    this.entries = new Map();
  }

  consume(keyId, nonce, expiresAt, now = Date.now()) {
    for (const [key, expiry] of this.entries) if (expiry < now) this.entries.delete(key);
    const key = `${keyId}:${nonce}`;
    if (this.entries.has(key)) return false;
    this.entries.set(key, expiresAt);
    return true;
  }
}

function bodyBuffer(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  throw new ControlEnvelopeError('control_body_invalid');
}

function sha256(body) {
  return createHash('sha256').update(bodyBuffer(body)).digest('hex');
}

function validateSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096 || CONTROL_CHARACTERS.test(secret)) {
    throw new ControlEnvelopeError('control_secret_invalid');
  }
}

function validateKeyId(keyId) {
  if (!KEY_ID_PATTERN.test(String(keyId ?? ''))) throw new ControlEnvelopeError('control_key_id_invalid');
}

function validateRequestId(requestId) {
  if (!UUID_PATTERN.test(String(requestId ?? ''))) throw new ControlEnvelopeError('control_request_id_invalid');
}

function validateRequestTarget(method, path) {
  if (!METHOD_PATTERN.test(String(method ?? '').toUpperCase())) throw new ControlEnvelopeError('control_method_invalid');
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 2048 || CONTROL_CHARACTERS.test(path)) {
    throw new ControlEnvelopeError('control_path_invalid');
  }
}

function hmac(secret, message) {
  return createHmac('sha256', secret).update(message).digest('hex');
}

function verifyMac(secret, canonical, signature) {
  validateSecret(secret);
  if (!HEX_SHA256_PATTERN.test(String(signature ?? ''))) throw new ControlEnvelopeError('control_signature_invalid');
  const expected = Buffer.from(hmac(secret, canonical), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new ControlEnvelopeError('control_signature_invalid');
  }
}

function header(headers, name) {
  if (headers?.get) return headers.get(name);
  if (!headers || typeof headers !== 'object') return null;
  const direct = headers[name];
  if (direct !== undefined) return Array.isArray(direct) ? direct[0] : String(direct);
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry ? (Array.isArray(entry[1]) ? entry[1][0] : String(entry[1])) : null;
}

function keyFor(keys, keyId) {
  const secret = keys instanceof Map ? keys.get(keyId) : (Object.hasOwn(keys ?? {}, keyId) ? keys[keyId] : undefined);
  if (secret === undefined) throw new ControlEnvelopeError('control_key_unknown');
  return secret;
}

function requestMetadata(headers) {
  const metadata = {
    version: header(headers, 'x-bairui-control-version'),
    keyId: header(headers, 'x-bairui-control-key-id'),
    timestamp: header(headers, 'x-bairui-control-timestamp'),
    nonce: header(headers, 'x-bairui-control-nonce'),
    requestId: header(headers, 'x-bairui-control-request-id'),
    signature: header(headers, 'x-bairui-control-signature'),
  };
  if (metadata.version !== VERSION) throw new ControlEnvelopeError('control_version_invalid');
  validateKeyId(metadata.keyId);
  validateRequestId(metadata.requestId);
  if (!NONCE_PATTERN.test(String(metadata.nonce ?? ''))) throw new ControlEnvelopeError('control_nonce_invalid');
  if (!/^\d{1,16}$/.test(String(metadata.timestamp ?? ''))) throw new ControlEnvelopeError('control_timestamp_invalid');
  if (!HEX_SHA256_PATTERN.test(String(metadata.signature ?? ''))) throw new ControlEnvelopeError('control_signature_invalid');
  return metadata;
}

function responseMetadata(headers) {
  const metadata = {
    version: header(headers, 'x-bairui-control-version'),
    keyId: header(headers, 'x-bairui-control-key-id'),
    requestId: header(headers, 'x-bairui-control-request-id'),
    requestNonce: header(headers, 'x-bairui-control-request-nonce'),
    signature: header(headers, 'x-bairui-control-response-signature'),
  };
  if (metadata.version !== VERSION) throw new ControlEnvelopeError('control_version_invalid');
  validateKeyId(metadata.keyId);
  validateRequestId(metadata.requestId);
  if (!NONCE_PATTERN.test(String(metadata.requestNonce ?? ''))) throw new ControlEnvelopeError('control_nonce_invalid');
  if (!HEX_SHA256_PATTERN.test(String(metadata.signature ?? ''))) throw new ControlEnvelopeError('control_signature_invalid');
  return metadata;
}

export function canonicalControlRequest({ version = VERSION, method, path, timestamp, nonce, requestId, body }) {
  return [version, String(method).toUpperCase(), path, String(timestamp), nonce, requestId, sha256(body)].join('\n');
}

export function canonicalControlResponse({ version = VERSION, status, requestId, requestNonce, body }) {
  return [version, String(status), requestId, requestNonce, sha256(body)].join('\n');
}

export function signControlRequest({ method, path, body = '', requestId, keyId, secret, now = Date.now(), nonce = randomUUID() }) {
  validateSecret(secret);
  validateKeyId(keyId);
  validateRequestId(requestId);
  validateRequestTarget(method, path);
  if (!Number.isSafeInteger(now) || now < 0) throw new ControlEnvelopeError('control_timestamp_invalid');
  if (!NONCE_PATTERN.test(String(nonce ?? ''))) throw new ControlEnvelopeError('control_nonce_invalid');
  const timestamp = String(now);
  const signature = hmac(secret, canonicalControlRequest({ method, path, body, requestId, timestamp, nonce }));
  return {
    'x-bairui-control-version': VERSION,
    'x-bairui-control-key-id': keyId,
    'x-bairui-control-timestamp': timestamp,
    'x-bairui-control-nonce': nonce,
    'x-bairui-control-request-id': requestId,
    'x-bairui-control-signature': signature,
  };
}

export function verifyControlRequest({ method, path, body = '', headers, keys, now = Date.now(), nonceStore }) {
  validateRequestTarget(method, path);
  const metadata = requestMetadata(headers);
  const timestamp = Number(metadata.timestamp);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > SIGNATURE_WINDOW_MS) {
    throw new ControlEnvelopeError('control_signature_expired');
  }
  const secret = keyFor(keys, metadata.keyId);
  verifyMac(secret, canonicalControlRequest({
    method,
    path,
    body,
    requestId: metadata.requestId,
    timestamp: metadata.timestamp,
    nonce: metadata.nonce,
  }), metadata.signature);
  if (!nonceStore?.consume || nonceStore.consume(metadata.keyId, metadata.nonce, timestamp + NONCE_RETENTION_MS, now) !== true) {
    throw new ControlEnvelopeError(nonceStore?.consume ? 'control_nonce_replayed' : 'control_nonce_store_invalid');
  }
  return metadata;
}

// Crypto validation is shared with the synchronous verifier; no metadata is
// returned until the durable, atomic nonce insert has explicitly succeeded.
export async function verifyControlRequestAsync(options) {
  let nonceArguments;
  const metadata = verifyControlRequest({ ...options, nonceStore: {
    consume(...args) { nonceArguments = args; return true; },
  } });
  if (!options.nonceStore?.consume) throw new ControlEnvelopeError('control_nonce_store_invalid');
  if (await options.nonceStore.consume(...nonceArguments) !== true) throw new ControlEnvelopeError('control_nonce_replayed');
  return metadata;
}

export function signControlResponse({ status, requestId, requestNonce, body = '', keyId, secret }) {
  validateSecret(secret);
  validateKeyId(keyId);
  validateRequestId(requestId);
  if (!NONCE_PATTERN.test(String(requestNonce ?? ''))) throw new ControlEnvelopeError('control_nonce_invalid');
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw new ControlEnvelopeError('control_status_invalid');
  const signature = hmac(secret, canonicalControlResponse({ status, requestId, requestNonce, body }));
  return {
    'x-bairui-control-version': VERSION,
    'x-bairui-control-key-id': keyId,
    'x-bairui-control-request-id': requestId,
    'x-bairui-control-request-nonce': requestNonce,
    'x-bairui-control-response-signature': signature,
  };
}

export function verifyControlResponse({ status, requestId, requestNonce, body = '', headers, keys }) {
  validateRequestId(requestId);
  if (!NONCE_PATTERN.test(String(requestNonce ?? ''))) throw new ControlEnvelopeError('control_nonce_invalid');
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) throw new ControlEnvelopeError('control_status_invalid');
  const metadata = responseMetadata(headers);
  if (metadata.requestId !== requestId || metadata.requestNonce !== requestNonce) throw new ControlEnvelopeError('control_response_mismatch');
  const secret = keyFor(keys, metadata.keyId);
  verifyMac(secret, canonicalControlResponse({ status, requestId, requestNonce, body }), metadata.signature);
  return metadata;
}
