import test from 'node:test';
import assert from 'node:assert/strict';

import { PostgresStore } from '../src/postgres-store.mjs';

test('PostgresStore can be constructed with a pool and exposes a readiness check', async () => {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ ok: 1 }] };
    },
    async end() {},
  };

  const store = new PostgresStore({ pool });
  assert.deepEqual(await store.ping(), { ok: 1 });
  assert.equal(calls[0].text, 'SELECT 1 AS ok');
  await store.close();
});
