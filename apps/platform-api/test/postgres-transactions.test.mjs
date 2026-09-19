import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { Pool } from 'pg';
import { PostgresStore } from '../src/postgres-store.mjs';
import { PostgresTaskStore } from '../src/scheduler/task-store.mjs';

const scope = { organizationId: 'org-timeout-test', userId: 'user-timeout-test' };
const operations = [
  ['identity provisioning', pool => new PostgresStore({ pool }).ensureIdentityUser({ subject: 'auth-test', email: 'test@example.test' })],
  ['local registration', pool => new PostgresStore({ pool }).createUserWithOrganization({ email: 'test@example.test' })],
  ['user scope', pool => new PostgresStore({ pool }).withScope(scope, async () => 'ok')],
  ['outbox claim', pool => new PostgresStore({ pool }).claimOutbox('worker-test')],
  ['outbox completion', pool => new PostgresStore({ pool }).completeOutbox('job-test', 'worker-test', 'done')],
  ['scheduler scope', pool => new PostgresTaskStore(pool).scoped(scope, async () => 'ok')],
  ['scheduler mutation', pool => new PostgresTaskStore(pool).mutate({}, () => 'ok')],
];

for (const [name, run] of operations) {
  for (const failedRollback of [false, true]) {
    test(`${name}: ${failedRollback ? 'failed rollback discards connection' : 'confirmed rollback permits reuse'} and preserves the original error`, async () => {
      const original = new Error('request_query_timeout');
      const rollbackError = new Error('rollback_query_timeout');
      const queries = [], releases = [];
      const client = {
        async query(sql) {
          queries.push(sql);
          if (sql === 'BEGIN') return { rows: [] };
          if (sql === 'ROLLBACK') {
            if (failedRollback) throw rollbackError;
            return { rows: [] };
          }
          throw original;
        },
        release(error) { releases.push(error); },
      };
      let caught;
      try { await run({ connect: async () => client }); } catch (error) { caught = error; }
      assert.equal(releases.length, 1);
      assert.equal(releases[0], failedRollback ? rollbackError : undefined);
      assert.equal(caught, original);
      assert.equal(queries.at(-1), 'ROLLBACK');
      assert.ok(!queries.includes('COMMIT'));
    });
  }
}

test('successful scoped transaction commits before returning a reusable connection', async () => {
  const calls = [], releases = [];
  const client = {
    async query(sql) { calls.push(sql); return { rows: [] }; },
    release(error) { releases.push(error); calls.push('release'); },
  };
  const store = new PostgresStore({ pool: { connect: async () => client } });
  assert.equal(await store.withScope(scope, async () => 'ok'), 'ok');
  assert.deepEqual(calls.slice(-2), ['COMMIT', 'release']);
  assert.deepEqual(releases, [undefined]);
});

// Exercise the real pg timeout queue and pool with an in-memory wire transport.
function wireMessage(type, text) {
  const payload = Buffer.from(text), header = Buffer.alloc(5);
  header[0] = type.charCodeAt(0);
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

class StalledTransactionStream extends Duplex {
  constructor() { super(); this.queries = []; }
  _read() {}
  setNoDelay() {}
  connect() { queueMicrotask(() => this.emit('connect')); }
  _final(callback) { callback(); this.destroy(); }
  reply(...messages) {
    queueMicrotask(() => { if (!this.destroyed) this.push(Buffer.concat(messages)); });
  }
  _write(buffer, encoding, callback) {
    const type = String.fromCharCode(buffer[0]);
    if (buffer[0] === 0) {
      this.reply(wireMessage('Z', 'I'));
    } else if (type === 'Q') {
      const sql = buffer.toString('utf8', 5, buffer.length - 1);
      this.queries.push(sql);
      if (sql === 'BEGIN') this.reply(wireMessage('C', 'BEGIN\0'), wireMessage('Z', 'T'));
      if (sql === 'SELECT 1') this.reply(wireMessage('C', 'SELECT 0\0'), wireMessage('Z', 'I'));
    } else if (type === 'P') {
      const start = buffer.indexOf(0, 5) + 1;
      this.queries.push(buffer.toString('utf8', start, buffer.indexOf(0, start)));
      // Leave the scoped query active: pg's queued ROLLBACK will also time out.
    }
    callback();
  }
}

test('real pg query and rollback timeouts discard the socket before the next pool checkout', { timeout: 5000 }, async () => {
  const streams = [];
  const pool = new Pool({
    user: 'wire-test', database: 'wire-test', password: 'unused', ssl: false,
    host: '127.0.0.1', port: 1, max: 1, query_timeout: 40, connectionTimeoutMillis: 1000,
    stream: () => { const stream = new StalledTransactionStream(); streams.push(stream); return stream; },
  });
  try {
    const store = new PostgresStore({ pool });
    await assert.rejects(store.withScope(scope, async () => assert.fail('scoped callback must not run')), /Query read timeout/);
    assert.equal(streams.length, 1);
    assert.ok(streams[0].queries.some(sql => sql.includes('set_config')));
    assert.ok(!streams[0].queries.includes('ROLLBACK'), 'rollback expired while still queued');
    assert.equal(streams[0].destroyed, true);
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.idleCount, 0);
    await pool.query('SELECT 1');
    assert.equal(streams.length, 2, 'the next request must open a fresh connection');
    assert.deepEqual(streams[1].queries, ['SELECT 1']);
  } finally { await pool.end(); }
});
