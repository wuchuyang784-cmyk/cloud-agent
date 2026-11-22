import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';

const env = {
  NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: 'http://localhost:8080',
  BETTER_AUTH_SECRET: 'test-only-secret-with-at-least-32-characters',
};
const database = () => memoryAdapter({ ba_user: [], ba_session: [], ba_account: [], ba_verification: [], ba_rate_limit: [] });

test('auth email defaults off; no mail endpoint or provider configuration needed', async t => {
  const app = createApp({ env, store: new MemoryStore(), authOptions: { betterAuthDatabase: database() } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = 'http://127.0.0.1:' + app.address().port;
  assert.equal((await (await fetch(base + '/api/auth/config')).json()).emailMode, 'off');
  const result = await fetch(base + '/api/auth/password-reset/request', {
    method: 'POST', headers: { origin: env.BETTER_AUTH_URL, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'user@example.test' }),
  });
  assert.equal(result.status, 404);
});

test('enabled mail auth never uses the MemoryStore or accepts an invalid mode', () => {
  for (const mode of ['transition', 'enforce', 'invalid']) {
    assert.throws(() => createApp({
      env: { ...env, BAIRUI_AUTH_EMAIL_MODE: mode }, store: new MemoryStore(),
      authOptions: { betterAuthDatabase: database() },
    }), /auth_email_configuration_invalid/);
  }
});

test('mail transport sends only to the fixed Resend endpoint with redirect refusal', async () => {
  const { createResendSender } = await import('../src/auth/email-delivery.mjs');
  const calls = [];
  const send = createResendSender({ from: 'auth@example.test', key: 're_fixture' }, async (...args) => {
    calls.push(args);
    return new Response(null, { status: 200 });
  });
  await send({ to: 'user@example.test', kind: 'verify', link: 'https://console.example.test/auth/verify#token=fixture' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://api.resend.com/emails');
  assert.equal(calls[0][1].redirect, 'error');
  const body = JSON.parse(calls[0][1].body);
  assert.deepEqual(body.to, ['user@example.test']);
  assert.ok(body.text.includes('https://console.example.test/auth/verify#token=fixture'));
});
