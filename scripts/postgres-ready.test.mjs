import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForPostgres } from './postgres-ready.mjs';

test('readiness retries connection and query failures, closing every client', async () => {
  let created = 0, closed = 0, queried = 0, waits = 0;
  await waitForPostgres(() => {
    const attempt = ++created;
    return {
      on() {},
      async connect() { if (attempt === 1) throw new Error('connection reset'); },
      async query(sql) { assert.equal(sql, 'SELECT 1'); queried++; if (attempt === 2) throw new Error('starting'); },
      async end() { closed++; },
    };
  }, { attempts: 3, pause: async () => { waits++; } });
  assert.equal(created, 3);
  assert.equal(closed, 3);
  assert.equal(queried, 2);
  assert.equal(waits, 2);
});

test('readiness stops with a bounded timeout and does not expose connection errors', async () => {
  let closed = 0;
  await assert.rejects(waitForPostgres(() => ({
    on() {},
    async connect() { throw new Error('secret connection string'); },
    async end() { closed++; },
  }), { attempts: 2, pause: async () => {} }), /^Error: test_database_start_timeout$/);
  assert.equal(closed, 2);
});
