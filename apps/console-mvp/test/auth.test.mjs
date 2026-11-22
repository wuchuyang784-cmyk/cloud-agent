import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
const js = stripTypeScriptTypes(source.replaceAll('import.meta.env', '({})'));
const api = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('Better Auth login obtains platform identity rather than trusting provider user fields', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    paths.push(path);
    assert.equal(options.credentials, 'include');
    const payload = path.endsWith('/config') ? { provider: 'better-auth' }
      : path.endsWith('/me') ? { user: { userId: 'platform-user', organizationId: 'personal' } }
      : { user: { id: 'provider-user' } };
    return Response.json(payload);
  });
  const user = await api.loginAccount('a@example.test', 'password-12345');
  assert.equal(user.userId, 'platform-user');
  assert.deepEqual(paths, ['/api/auth/config', '/api/auth/sign-in/email', '/api/auth/me']);
});

test('Better Auth registration supplies a name and maps provider errors', async t => {
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    if (path.endsWith('/config')) return Response.json({ provider: 'better-auth' });
    assert.equal(path, '/api/auth/sign-up/email');
    assert.equal(JSON.parse(options.body).name, 'Alice');
    return Response.json({ code: 'PASSWORD_TOO_SHORT', message: 'Password too short' }, { status: 400 });
  });
  await assert.rejects(api.registerAccount({ email: 'a@example.test', password: 'short', displayName: 'Alice' }), error => error.code === 'PASSWORD_TOO_SHORT');
});

test('email mode defaults to off for older or unrecognized auth config', async t => {
  for (const [configured, expected] of [[undefined, 'off'], ['unknown', 'off'], ['off', 'off'], ['transition', 'transition'], ['enforce', 'enforce']]) {
    t.mock.method(globalThis, 'fetch', async (path, options) => {
      assert.equal(path, '/api/auth/config');
      assert.equal(options.cache, 'no-store');
      return Response.json({ provider: 'better-auth', emailMode: configured });
    });
    assert.equal(await api.fetchEmailMode(), expected);
  }
});

test('enforced registration requests verification without reading a session', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async path => {
    paths.push(path);
    return Response.json(path.endsWith('/config') ? { provider: 'better-auth', emailMode: 'enforce' } : { token: null });
  });
  assert.equal(await api.registerAccount({ email: 'a@example.test', password: 'password-12345' }), null);
  assert.deepEqual(paths, ['/api/auth/config', '/api/auth/sign-up/email']);
});

test('email request endpoints preserve a generic acceptance and avoid session-expired events', async t => {
  const events = [];
  globalThis.window = { dispatchEvent(event) { events.push(event.type); } };
  t.after(() => { delete globalThis.window; });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push([path, init.method, JSON.parse(init.body)]);
    return path.endsWith('/confirm') ? Response.json({}, { status: 401 }) : Response.json({ accepted: true }, { status: 202 });
  });
  await api.requestPasswordReset('a@example.test');
  await api.requestEmailVerification();
  await assert.rejects(api.confirmEmailVerification('A'.repeat(43)), { status: 401 });
  await assert.rejects(api.confirmPasswordReset('A'.repeat(43), 'password-12345'), { status: 401 });
  assert.deepEqual(calls, [
    ['/api/auth/password-reset/request', 'POST', { email: 'a@example.test' }],
    ['/api/auth/email-verification/request', 'POST', {}],
    ['/api/auth/email-verification/confirm', 'POST', { token: 'A'.repeat(43) }],
    ['/api/auth/password-reset/confirm', 'POST', { token: 'A'.repeat(43), newPassword: 'password-12345' }],
  ]);
  assert.deepEqual(events, []);
});

test('expired sessions notify the console and logout failures remain failures', async t => {
  let expired = 0;
  globalThis.window = { dispatchEvent(event) { if (event.type === 'bairui:session-expired') expired++; } };
  t.after(() => { delete globalThis.window; });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'unauthenticated' } }, { status: 401 }));
  assert.equal(await api.fetchCurrentUser(), null);
  assert.equal(expired, 1);
  t.mock.method(globalThis, 'fetch', async path => path.endsWith('/config') ? Response.json({ provider: 'better-auth' }) : Response.json({}, { status: 503 }));
  await assert.rejects(api.logoutAccount(), error => error.status === 503);
});

test('governance feedback refreshes identity; cancelled identity requests cannot expire a new session', async t => {
  const events = [];
  globalThis.window = { dispatchEvent(event) { events.push(event.type); } };
  t.after(() => { delete globalThis.window; });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'account_suspended' } }, { status: 403 }));
  await assert.rejects(api.createResource({ kind: 'skill', name: 'blocked' }), error => error.code === 'account_suspended' && error.message.includes('暂停'));
  assert.deepEqual(events, ['bairui:account-refresh']);
  let finish;
  t.mock.method(globalThis, 'fetch', (_path, init) => {
    assert.equal(init.cache, 'no-store');
    return new Promise(resolve => { finish = resolve; });
  });
  const controller = new AbortController();
  const pending = api.fetchCurrentUser(controller.signal);
  controller.abort();
  finish(Response.json({ error: { code: 'unauthenticated' } }, { status: 401 }));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(events, ['bairui:account-refresh']);
});
