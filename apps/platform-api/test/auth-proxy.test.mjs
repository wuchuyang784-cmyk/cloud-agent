import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { BetterAuthPrincipalResolver } from '../src/auth/better-auth-resolver.mjs';
import { MemoryStore } from '../src/store.mjs';

const env = { NODE_ENV: 'test', BETTER_AUTH_SECRET: 'test-secret-with-at-least-32-characters', BETTER_AUTH_URL: 'http://localhost:8080' };
function resolver(trusted = '') {
  return new BetterAuthPrincipalResolver(new MemoryStore(), { env: { ...env, BAIRUI_TRUSTED_PROXIES: trusted }, betterAuthDatabase: memoryAdapter({}) });
}
async function forwardedIP(trusted, peer, headers = {}) {
  const auth = resolver(trusted);
  let ip;
  auth.auth.handler = async req => { ip = req.headers.get('x-bairui-peer-ip'); return Response.json({}); };
  const req = Readable.from([Buffer.from('{}')]);
  req.method = 'POST'; req.socket = { remoteAddress: peer }; req.headers = headers;
  await auth.handle(req, { setHeader() {}, end() {} }, '/api/auth/sign-in/email', 16384);
  return ip;
}

test('untrusted peers cannot spoof forwarding or internal identity headers', async () => {
  assert.equal(await forwardedIP('', '198.51.100.7', { 'x-forwarded-for': '203.0.113.1', 'x-real-ip': '203.0.113.2', 'x-bairui-peer-ip': '203.0.113.3' }), '198.51.100.7');
  assert.equal(await forwardedIP('10.20.0.2', '198.51.100.7', { 'x-forwarded-for': 'invalid' }), '198.51.100.7');
});

test('trusted chain selects the nearest untrusted hop, never a forged leftmost address', async () => {
  assert.equal(await forwardedIP('10.20.0.2/32', '10.20.0.2', { 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9');
  assert.equal(await forwardedIP('10.20.0.2,10.20.0.3', '10.20.0.2', { 'x-forwarded-for': '192.0.2.99, 203.0.113.9, 10.20.0.3', 'x-bairui-peer-ip': '192.0.2.1' }), '203.0.113.9');
  assert.equal(await forwardedIP('127.0.0.1/32', '::ffff:127.0.0.1', { 'x-forwarded-for': '2001:db8::1' }), '2001:db8::1');
  assert.equal(await forwardedIP('::1/128', '::1', { 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9');
});

test('malformed or overlong trusted forwarding chains fail closed', async () => {
  for (const value of ['not-an-ip', '203.0.113.9,', '203.0.113.9:1234', '1.2.3.999', Array(18).fill('203.0.113.9').join(','), ' '.repeat(2049)]) {
    await assert.rejects(forwardedIP('127.0.0.1', '127.0.0.1', { 'x-forwarded-for': value }), /invalid_client_ip/, value);
  }
  await assert.rejects(forwardedIP('', undefined), /invalid_client_ip/);
  assert.equal(await forwardedIP('127.0.0.1', '127.0.0.1'), '127.0.0.1');
});

test('trusted proxy config accepts explicit addresses only, not trust-all shortcuts', () => {
  for (const value of ['*', 'true', 'loopback', 'private_ranges', '0.0.0.0/0', '::/0', '127.0.0.1/99', 'localhost', '127.0.0.1,']) {
    assert.throws(() => resolver(value), /BAIRUI_TRUSTED_PROXIES/, value);
  }
});
