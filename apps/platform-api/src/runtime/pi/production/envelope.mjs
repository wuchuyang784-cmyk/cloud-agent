import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
const canonical = ({ method, target, timestamp, nonce, body, agentId, runId, runGeneration }) => ['bairui-pi-v1', method, target, timestamp, nonce, agentId, runId, String(runGeneration), body].join('\n');
export function signTaskRequest({ secret, method, target, timestamp = String(Date.now()), nonce = randomUUID(), body, agentId, runId, runGeneration }) {
  return { 'x-pi-timestamp': String(timestamp), 'x-pi-nonce': nonce, 'x-pi-signature': createHmac('sha256', secret).update(canonical({ method, target, timestamp, nonce, body, agentId, runId, runGeneration })).digest('hex') };
}
export function createEnvelopeVerifier(config, secret, { now: clock = Date.now } = {}) {
  const nonces = new Map();
  return (request, body) => {
    const timestamp = request.headers['x-pi-timestamp'], nonce = request.headers['x-pi-nonce'], signature = request.headers['x-pi-signature'];
    const now = clock();
    if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > config.limits.nonceTtlMs || typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(nonce) || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
    const expected = signTaskRequest({ secret, method: request.method, target: request.url, timestamp, nonce, body, ...config })['x-pi-signature'];
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) return false;
    for (const [key, expires] of nonces) if (expires < now) nonces.delete(key);
    if (nonces.has(nonce) || nonces.size >= config.limits.maxNonces) return false;
    // A future-skewed signature stays acceptable until its signed time plus TTL.
    nonces.set(nonce, Number(timestamp) + config.limits.nonceTtlMs); return true;
  };
}
