import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { createApp } from '../src/app.mjs';
import { PostgresStore } from '../src/postgres-store.mjs';

const connectionString = process.env.BAIRUI_AUTH_EMAIL_TEST_DATABASE_URL;
const origin = 'http://localhost:8080';
const prefix = '/api/auth';
const verifyRequest = '/email-verification/request';
const verifyConfirm = '/email-verification/confirm';
const resetRequest = '/password-reset/request';
const resetConfirm = '/password-reset/confirm';
const oldPassword = 'auth-fixture-password-before';
const newPassword = 'auth-fixture-password-after';
const cookieOf = response => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');

async function waitFor(check, description, milliseconds = 3500) {
  const until = performance.now() + milliseconds;
  do {
    const result = await check();
    if (result) return result;
    await sleep(25);
  } while (performance.now() < until);
  assert.fail('Timed out waiting for ' + description);
}

async function status(response, expected) {
  assert.equal(response.status, expected, new URL(response.url).pathname);
  return response.json();
}

async function accepted(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await status(response, 202), { accepted: true });
}

async function invalid(response) {
  assert.equal((await status(response, 400)).error.code, 'invalid_or_expired_link');
}

test('PostgreSQL mail auth with independently pooled API replicas and a fake sender', {
  skip: !connectionString, timeout: 85000,
}, async t => {
  const url = new URL(connectionString);
  assert.ok(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && Number(url.port) > 0
    && /^\/auth_email_test_[a-f0-9]{24}$/.test(url.pathname) && !url.search && !url.hash,
  'Use the disposable loopback database created by scripts/test-auth-email.mjs');
  const owner = new Pool({ connectionString, connectionTimeoutMillis: 2000 });
  const pools = [];
  const apps = [];
  const outbox = [];
  const env = {
    NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), BAIRUI_TRUSTED_PROXIES: '127.0.0.1/32',
  };
  let requestCount = 0;
  t.after(async () => {
    try {
      await Promise.all(apps.map(app => new Promise(resolve => app.close(resolve))));
      await Promise.all(pools.map(pool => pool.end()));
    } finally { await owner.end(); }
  });

  const { rows: [identity] } = await owner.query('SELECT current_database() AS db, current_user AS owner');
  assert.ok(identity.db === url.pathname.slice(1) && identity.owner === 'postgres', 'Fixture database identity');
  assert.equal((await owner.query("SELECT to_regclass('public.ba_user') IS NULL AS fresh")).rows[0].fresh, true);
  const migrations = new URL('../../../packages/db/migrations/', import.meta.url);
  for (const migration of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await owner.query(await readFile(new URL(migration, migrations), 'utf8'));
  }
  const emailMigration = await readFile(new URL('047_auth_email_challenges.sql', migrations), 'utf8');
  await owner.query(`
    CREATE ROLE auth_email_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO auth_email_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO auth_email_app;
    REVOKE ALL ON platform_account_governance, platform_governance_audit, platform_role_bindings, platform_admin_audit, ba_email_challenge FROM auth_email_app;
    GRANT SELECT, INSERT, UPDATE ON ba_email_challenge TO auth_email_app;
    GRANT EXECUTE ON FUNCTION platform_account_access(text), platform_account_session_allowed(text) TO auth_email_app;
  `);

  async function start(mode, publicOrigin = origin) {
    const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 2000,
      application_name: `auth-email-fixture-${pools.length}`, options: '-c role=auth_email_app' });
    pools.push(pool);
    const app = createApp({ env: { ...env, BAIRUI_AUTH_EMAIL_MODE: mode, BETTER_AUTH_URL: publicOrigin }, store: new PostgresStore({ pool }),
      authOptions: { emailSender: async message => { outbox.push(message); } } });
    await new Promise((resolve, reject) => app.once('error', reject).listen(0, '127.0.0.1', resolve));
    apps.push(app);
    return 'http://127.0.0.1:' + app.address().port;
  }

  const off = await start('off');
  const transition = await start('transition');
  const transitionReplica = await start('transition');
  const enforce = await start('enforce');
  const enforceReplica = await start('enforce');

  function request(base, path, { body, cookie, headers } = {}) {
    const index = ++requestCount;
    return fetch(base + prefix + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'x-forwarded-for': `198.51.100.${index}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(7500),
    });
  }

  const signup = (base, email) => request(base, '/sign-up/email', { body: { email, name: 'Mail Test', password: oldPassword } });
  const signin = (base, email, password = oldPassword) => request(base, '/sign-in/email', { body: { email, password } });
  const me = (base, cookie) => request(base, '/me', { cookie });
  const sendReset = (base, email) => request(base, resetRequest, { body: { email } });
  const confirmReset = (base, token, password = newPassword) => request(base, resetConfirm, { body: { token, newPassword: password } });
  const confirmVerify = (base, token) => request(base, verifyConfirm, { body: { token } });
  const mails = (kind, email) => outbox.filter(message => message.kind === kind && message.to === email);
  const challenge = async (kind, email) => (await owner.query('SELECT * FROM ba_email_challenge WHERE purpose=$1 AND email=$2', [kind, email])).rows[0];
  const ageChallenge = (kind, email, expired = false) => owner.query(`
    UPDATE ba_email_challenge SET issued_at = now() - interval '2 days',
      expires_at = now() + $3 * interval '1 hour' WHERE purpose = $1 AND email = $2`, [kind, email, expired ? -1 : 1]);

  async function link(kind, email, count = 1) {
    const message = await waitFor(() => mails(kind, email)[count - 1], `${kind} message ${count}`);
    const link = new URL(message.link);
    assert.equal(link.origin, origin);
    assert.equal(link.pathname, '/auth/' + kind);
    assert.equal(link.search, '');
    const token = new URLSearchParams(link.hash.slice(1)).get('token');
    assert.ok(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), '43-character fragment token');
    const row = await challenge(kind, email);
    assert.ok(row.token_digest === createHash('sha256').update(token).digest('hex'), 'Database stores only the token digest');
    return { token, link, id: row.auth_user_id };
  }

  async function registerOld(email) {
    const registered = await signup(off, email);
    await status(registered, 200);
    const cookie = cookieOf(registered);
    assert.ok(cookie);
    return cookie;
  }

  async function registerVerified(email) {
    const oldCookie = await registerOld(email);
    await accepted(await request(transition, verifyRequest, { body: {}, cookie: oldCookie }));
    const { token, id } = await link('verify', email);
    assert.deepEqual(await status(await confirmVerify(transitionReplica, token), 200), { ok: true });
    const response = await signin(enforce, email);
    await status(response, 200);
    const cookie = cookieOf(response);
    return { cookie, id, user: (await status(await me(enforce, cookie), 200)).user };
  }

  await t.test('transition retains old access, pauses signup and accepts verification only from an authenticated same-origin request', async () => {
    assert.equal((await status(await request(transition, '/config'), 200)).emailMode, 'transition');
    const email = 'transition@example.test';
    const cookie = await registerOld(email);
    const old = await status(await me(transition, cookie), 200);
    assert.equal(old.user.emailVerified, false);
    assert.equal((await me(enforce, cookie)).status, 401);
    assert.equal((await signup(transition, 'paused@example.test')).status, 403);
    assert.equal((await request(transition, verifyRequest, { body: {} })).status, 401);
    assert.equal((await request(transition, verifyRequest, { body: {}, cookie, headers: { origin: 'https://untrusted.example.test' } })).status, 403);
    const mismatch = await request(transition, verifyRequest, { body: {}, cookie,
      headers: { 'x-bairui-expected-user': 'user-00000000-0000-4000-8000-000000000001' } });
    assert.equal(mismatch.status, 409);
    assert.equal(await challenge('verify', email), undefined);
    await accepted(await sendReset(transition, email));
    const requests = await Promise.all([
      request(transition, verifyRequest, { body: {}, cookie, headers: { 'x-bairui-expected-user': old.user.userId } }),
      request(transitionReplica, verifyRequest, { body: {}, cookie }),
    ]);
    await Promise.all(requests.map(accepted));
    const { token, link: url } = await link('verify', email);
    await sleep(100);
    assert.equal(mails('verify', email).length, 1);
    assert.equal(mails('reset', email).length, 0);
    const scanned = await fetch(transitionReplica + url.pathname);
    await scanned.arrayBuffer();
    assert.equal((await request(transitionReplica, verifyConfirm)).status, 404);
    assert.equal((await challenge('verify', email)).consumed_at, null);
    await invalid(await confirmReset(transition, token));
    const verified = await confirmVerify(transitionReplica, token);
    assert.deepEqual(await status(verified, 200), { ok: true });
    assert.equal(verified.headers.getSetCookie().length, 0);
    await invalid(await confirmVerify(transition, token));
    assert.equal((await me(enforceReplica, cookie)).status, 401, 'Verification must not revive a pre-verification cookie');
    const logged = await signin(enforce, email);
    await status(logged, 200);
    const current = (await status(await me(enforceReplica, cookieOf(logged)), 200)).user;
    assert.equal(current.emailVerified, true);
    assert.equal(current.userId, old.user.userId);
    assert.equal(current.organizationId, old.user.organizationId);
  });

  await t.test('enforce signup creates no session and valid unverified signin resends after cooldown', async () => {
    const email = 'enforce@example.test';
    assert.equal((await status(await request(enforce, '/config'), 200)).emailMode, 'enforce');
    const signed = await signup(enforce, email);
    await status(signed, 200);
    assert.equal(signed.headers.getSetCookie().length, 0);
    const first = await link('verify', email);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM ba_session WHERE "userId"=$1', [first.id])).rows[0].n, 0);
    await ageChallenge('verify', email);
    const wrong = await signin(enforceReplica, email, newPassword);
    assert.equal(wrong.status, 401);
    assert.equal(mails('verify', email).length, 1);
    const rejected = await signin(enforceReplica, email);
    assert.equal((await status(rejected, 403)).code, 'EMAIL_NOT_VERIFIED');
    assert.equal(rejected.headers.getSetCookie().length, 0);
    const fresh = await link('verify', email, 2);
    assert.ok(fresh.token !== first.token, 'Resend rotates the token');
    await invalid(await confirmVerify(enforce, first.token));
    assert.deepEqual(await status(await confirmVerify(enforce, fresh.token), 200), { ok: true });
    const logged = await signin(enforceReplica, email);
    await status(logged, 200);
    assert.equal((await status(await me(enforce, cookieOf(logged)), 200)).user.emailVerified, true);
    for (const route of ['/verify-email', '/send-verification-email', '/request-password-reset', '/reset-password', '/change-email']) {
      assert.equal((await request(enforce, route, { body: {} })).status, 404);
    }
  });

  await t.test('parallel same-IP and IPv6 /64 signins share exactly three admissions across both replicas', async () => {
    const emails = ['limit-one', 'limit-two', 'limit-three', 'limit-four'].map(name => name + '@example.test');
    for (const email of emails) await registerVerified(email);
    for (const addresses of [emails.map(() => '198.51.100.240'), emails.map((_, index) => `2001:db8:abcd:1234::${index + 1}`)]) {
      const results = await Promise.all(emails.map((email, index) => request(index % 2 ? enforce : enforceReplica, '/sign-in/email', {
        body: { email, password: oldPassword }, headers: { 'x-forwarded-for': addresses[index] },
      })));
      assert.deepEqual(results.map(response => response.status).sort(), [200, 200, 200, 429], 'Replicas share the normalized client bucket');
      const retryAfter = Number(results.find(response => response.status === 429).headers.get('retry-after'));
      assert.ok(retryAfter > 0 && retryAfter <= 10);
      for (const [index, response] of results.entries()) {
        if (response.status === 200) assert.equal((await status(await me(enforce, cookieOf(response)), 200)).user.email, emails[index]);
        else assert.equal(response.headers.getSetCookie().length, 0);
      }
    }
    const mapped = await request(enforce, '/sign-in/email', {
      body: { email: emails[0], password: oldPassword }, headers: { 'x-forwarded-for': '::ffff:198.51.100.240' },
    });
    assert.equal(mapped.status, 429, 'IPv4-mapped IPv6 shares the IPv4 bucket');
  });

  await t.test('reset is generic, expires, rotates, consumes once across replicas and revokes existing sessions', async () => {
    const email = 'reset@example.test';
    const { cookie, id } = await registerVerified(email);
    await accepted(await sendReset(enforce, 'missing@example.test'));
    await accepted(await sendReset(enforceReplica, email));
    const first = await link('reset', email);
    await invalid(await confirmVerify(enforce, first.token));
    await ageChallenge('reset', email, true);
    await invalid(await confirmReset(enforce, first.token));
    assert.equal((await challenge('reset', email)).consumed_at, null);
    await Promise.all([enforce, enforceReplica].map(async base => accepted(await sendReset(base, email))));
    const fresh = await link('reset', email, 2);
    await invalid(await confirmReset(enforceReplica, first.token));
    const attempted = await Promise.all([enforce, enforceReplica].map(base => confirmReset(base, fresh.token)));
    assert.deepEqual(attempted.map(response => response.status).sort(), [200, 400]);
    assert.deepEqual(await attempted.find(response => response.ok).json(), { ok: true });
    await invalid(attempted.find(response => !response.ok));
    assert.equal(attempted.every(response => response.headers.getSetCookie().length === 0), true);
    assert.ok((await challenge('reset', email)).consumed_at);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM ba_session WHERE "userId"=$1', [id])).rows[0].n, 0);
    assert.equal((await me(enforceReplica, cookie)).status, 401);
    assert.equal((await signin(enforce, email)).status, 401);
    const logged = await signin(enforceReplica, email, newPassword);
    await status(logged, 200);
    assert.equal((await status(await me(enforce, cookieOf(logged)), 200)).user.emailVerified, true);
    assert.equal(mails('reset', 'missing@example.test').length, 0);
    assert.equal(mails('reset', email).length, 2);
  });

  await t.test('ban prevents new mail and confirmation while a suspended account retains read-only access after reset', async () => {
    const banned = 'banned@example.test';
    const suspended = 'suspended@example.test';
    const b = await registerVerified(banned);
    const s = await registerVerified(suspended);
    await accepted(await sendReset(enforce, banned));
    const banReset = await link('reset', banned);
    await owner.query(`INSERT INTO platform_account_governance(user_id,status,version) VALUES ($1,'banned',1),($2,'suspended',1)`, [b.user.userId, s.user.userId]);
    await ageChallenge('reset', banned);
    await accepted(await sendReset(enforceReplica, banned));
    await invalid(await confirmReset(enforce, banReset.token));
    assert.equal((await signin(enforceReplica, banned)).status, 403);
    await accepted(await sendReset(enforceReplica, suspended));
    const suspendedReset = await link('reset', suspended);
    assert.equal(mails('reset', banned).length, 1);
    await status(await confirmReset(enforce, suspendedReset.token), 200);
    const logged = await signin(enforce, suspended, newPassword);
    await status(logged, 200);
    const cookie = cookieOf(logged);
    assert.equal((await status(await me(enforceReplica, cookie), 200)).user.accountStatus, 'suspended');
    const write = await fetch(enforce + '/api/user/resources', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(write.status, 403);
  });

  await t.test('failure revoking sessions rolls back password and challenge consumption', async () => {
    const email = 'rollback@example.test';
    const { cookie, id } = await registerVerified(email);
    await accepted(await sendReset(enforce, email));
    const { token } = await link('reset', email);
    await owner.query(`CREATE FUNCTION fail_fixture_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture rollback'; END $$;
      CREATE TRIGGER fail_fixture_session_delete BEFORE DELETE ON ba_session FOR EACH ROW EXECUTE FUNCTION fail_fixture_session_delete()`);
    try {
      const failed = await confirmReset(enforceReplica, token);
      assert.ok(failed.status >= 500 && failed.status <= 599);
      assert.equal((await challenge('reset', email)).consumed_at, null);
      assert.equal((await me(enforce, cookie)).status, 200);
      assert.equal((await signin(enforceReplica, email, newPassword)).status, 401);
      assert.equal((await signin(enforce, email)).status, 200);
    } finally {
      await owner.query('DROP TRIGGER fail_fixture_session_delete ON ba_session; DROP FUNCTION fail_fixture_session_delete()');
    }
    await status(await confirmReset(enforceReplica, token), 200);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM ba_session WHERE "userId"=$1', [id])).rows[0].n, 0);
  });

  await t.test('an old-password signin arriving while reset holds the identity lock cannot create a session', async () => {
    const email = 'concurrent-login@example.test';
    const { id } = await registerVerified(email);
    await accepted(await sendReset(enforce, email));
    const { token } = await link('reset', email);
    await owner.query(`CREATE FUNCTION wait_fixture_account_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(78937, 2); RETURN NEW; END $$;
      CREATE TRIGGER wait_fixture_account_update BEFORE UPDATE OF password ON ba_account
      FOR EACH ROW EXECUTE FUNCTION wait_fixture_account_update()`);
    const client = await owner.connect();
    const pending = [];
    const blocked = async application => (await owner.query(`
      SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING (pid)
        WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=$1) AS waiting`, [application])).rows[0].waiting;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(78937, 2)');
      const resetting = confirmReset(enforce, token);
      pending.push(resetting);
      await waitFor(() => blocked('auth-email-fixture-3'), 'reset to hold the identity lock');
      const loggingIn = signin(enforceReplica, email);
      pending.push(loggingIn);
      await waitFor(() => blocked('auth-email-fixture-4'), 'old-password signin to wait on reset');
      await client.query('COMMIT');
      await status(await resetting, 200);
      const rejected = await loggingIn;
      assert.equal(rejected.status, 401);
      assert.equal(rejected.headers.getSetCookie().length, 0);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM ba_session WHERE "userId"=$1', [id])).rows[0].n, 0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await Promise.allSettled(pending);
      await owner.query('DROP TRIGGER wait_fixture_account_update ON ba_account; DROP FUNCTION wait_fixture_account_update()');
    }
  });

  if (process.env.BAIRUI_PLAYWRIGHT_MODULE) {
    await t.test('Chromium verification and password reset across the frontend and real PostgreSQL API', async () => {
      const { checkAuthEmailBrowser } = await import('../../../scripts/test-auth-email-browser.mjs');
      await checkAuthEmailBrowser({ start, waitFor, mails, registerOld, challenge });
    });
  }

  // Reapplying the migration preserves the granted privilege and consumed history.
  const before = (await owner.query('SELECT count(*) AS n FROM ba_email_challenge WHERE consumed_at IS NOT NULL')).rows;
  await owner.query(emailMigration);
  assert.deepEqual((await owner.query('SELECT count(*) AS n FROM ba_email_challenge WHERE consumed_at IS NOT NULL')).rows, before);
  assert.equal((await pools[0].query("SELECT has_table_privilege(current_user, 'ba_email_challenge', 'update') AS granted")).rows[0].granted, true);
});
