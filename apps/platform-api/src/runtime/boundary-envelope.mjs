// 平台 → Runtime Boundary 请求签名信封（docs/20 §4 / docs/25）。
// 平台转发前用共享密钥对 timestamp.nonce.rawBody 做 HMAC-SHA256 签名；
// Boundary 校验时间窗、nonce 防重放与签名后，才将操作下发到引擎实例。

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'sha256';

function digest(secret, message) {
  return createHmac(ALGORITHM, secret).update(message).digest('hex');
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

function rawBody(body) {
  if (body === undefined || body === null) return '';
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/**
 * 生成请求签名。
 * @param {{ secret: string, body?: string|object, now?: number, nonce?: string }} options
 * @returns {{ timestamp: string, nonce: string, signature: string }}
 */
export function signRequest({ secret, body, now = Date.now(), nonce = randomUUID() }) {
  const timestamp = String(now);
  const signature = digest(secret, [timestamp, nonce, rawBody(body)].join('.'));
  return { timestamp, nonce, signature };
}

/**
 * 生成可直接放在 HTTP 请求头/入参上的信封对象。
 * @returns {{ 'x-bairui-timestamp': string, 'x-bairui-nonce': string, 'x-bairui-signature': string }}
 */
export function envelopeHeaders(options) {
  const { timestamp, nonce, signature } = signRequest(options);
  return {
    'x-bairui-timestamp': timestamp,
    'x-bairui-nonce': nonce,
    'x-bairui-signature': signature,
  };
}

/**
 * 校验信封。
 * @param {{ secret: string, timestamp: string, nonce: string, signature: string,
 *           body?: string|object, now?: number, nonceWindowMs?: number,
 *           seenNonces?: Set<string>|null }} options
 * @returns {{ ok: true } | { ok: false, error: 'stale_timestamp'|'replayed_nonce'|'invalid_signature' }}
 */
export function verifyEnvelope({ secret, timestamp, nonce, signature, body, now = Date.now(), nonceWindowMs = 5 * 60 * 1000, seenNonces = null }) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > nonceWindowMs) {
    return { ok: false, error: 'stale_timestamp' };
  }
  if (seenNonces && seenNonces.has(nonce)) {
    return { ok: false, error: 'replayed_nonce' };
  }
  const expected = digest(secret, [String(ts), nonce, rawBody(body)].join('.'));
  if (!safeEqualHex(expected, signature)) {
    return { ok: false, error: 'invalid_signature' };
  }
  seenNonces?.add(nonce);
  return { ok: true };
}
