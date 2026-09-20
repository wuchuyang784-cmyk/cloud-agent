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
