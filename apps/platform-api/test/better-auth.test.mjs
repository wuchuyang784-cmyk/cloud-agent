import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';

const env = { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: 'http://localhost:8080', BETTER_AUTH_SECRET: 'test-only-secret-with-at-least-32-characters' };

test('Better Auth requires explicit secrets and persistent storage outside tests', () => {
  assert.throws(() => createApp({ env: { BAIRUI_AUTH_MODE: 'better-auth' }, store: new MemoryStore() }), /DATABASE_URL/);
  assert.throws(() => createApp({ env: { ...env, NODE_ENV: 'production', BETTER_AUTH_URL: 'https://console.example.test' }, store: new MemoryStore() }), /PostgreSQL/);
});

test('real Better Auth handler: signup, tenant scope, logout, invalid origin and legacy bypass', async () => {
  const database = { ba_user: [], ba_session: [], ba_account: [], ba_verification: [], ba_rate_limit: [] };
  const app = createApp({ env, store: new MemoryStore(), authOptions: { betterAuthDatabase: memoryAdapter(database) } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  const post = (path, body, headers = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: env.BETTER_AUTH_URL, ...headers }, body: JSON.stringify(body),
  });
  try {
    const signup = await post('/api/auth/sign-up/email', { email: 'new@example.test', password: 'password-12345', name: 'New' });
    assert.equal(signup.status, 200, await signup.clone().text());
    const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie);
    const me = await fetch(base + '/api/auth/me', { headers: { cookie } });
    assert.equal(me.status, 200);
    const { user } = await me.json();
    assert.equal(user.organizations.length, 1);
    assert.equal(user.organizations[0].kind, 'personal');
    assert.equal(app.platform.store.organizations.size, 1);
    assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie } })).status, 200);
    assert.equal(app.platform.store.organizations.size, 1);
    assert.equal((await post('/api/auth/dev-login', {})).status, 404);
    assert.equal((await post('/api/auth/login', {})).status, 404);
    assert.equal((await post('/api/auth/sign-in/email', { email: 'new@example.test', password: 'password-12345' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/auth/sign-out', {}, { cookie })).status, 200);
    assert.equal((await fetch(base + '/api/auth/me', { headers: { cookie } })).status, 401);
    const login = await post('/api/auth/sign-in/email', { email: 'new@example.test', password: 'password-12345' });
    assert.equal(login.status, 200);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});
