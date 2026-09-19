import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSecretEnv } from '../src/secret-env.mjs';

const secret = { DATABASE_URL: 'postgres://app:private-password@db:5432/bairui_preprod', BAIRUI_SESSION_SECRET: 'a'.repeat(64), BETTER_AUTH_SECRET: 'b'.repeat(64) };
const loader = data => async () => typeof data === 'string' ? data : JSON.stringify(data);

test('optional secret loading preserves local env; explicit file only accepts approved keys', async () => {
  const local = { NODE_ENV: 'test' };
  assert.deepEqual(await loadSecretEnv(local), local);
  const env = { NODE_ENV: 'production', BAIRUI_SECRET_FILE: '/run/secrets/platform-env' };
  assert.deepEqual(await loadSecretEnv(env, loader(secret)), { ...env, ...secret });
  assert.equal(env.DATABASE_URL, undefined);
});

test('secret loading fails closed without leaking content or falling back to inherited credentials', async () => {
  const env = { BAIRUI_SECRET_FILE: '/run/secrets/platform-env' };
  for (const data of ['not-json-private-password', [], null, { ...secret, NODE_ENV: 'test' }, { ...secret, BETTER_AUTH_SECRET: 'short' }, { ...secret, DATABASE_URL: 'https://private-password.test' }]) {
    await assert.rejects(loadSecretEnv(env, loader(data)), error => !error.message.includes('private-password'));
  }
  await assert.rejects(loadSecretEnv({ ...env, DATABASE_URL: 'postgres://other' }, loader(secret)), /conflict/);
  await assert.rejects(loadSecretEnv(env, async () => { throw new Error('private-password'); }), /secret_file_unavailable/);
});
