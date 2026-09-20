import test from 'node:test';
import assert from 'node:assert/strict';
import { Kysely, PostgresDialect } from 'kysely';
import { rateLimitTimestampPlugin } from '../src/auth/postgres-database.mjs';

async function transform(table, rows) {
  const plugin = rateLimitTimestampPlugin();
  const queryId = {};
  const db = new Kysely({ dialect: new PostgresDialect({ pool: {} }) });
  const node = db.selectFrom(eb => eb.selectFrom(table).selectAll().as('primary')).selectAll('primary').toOperationNode();
  assert.equal(plugin.transformQuery({ node, queryId }), node);
  return (await plugin.transformResult({ queryId, result: { rows } })).rows;
}

test('auth database: rate-limit timestamps normalize without changing other bigint fields', async () => {
  const original = { lastRequest: '1789635935872', count: 3, other: '9007199254740999' };
  const rows = await transform('ba_rate_limit', [original, { lastRequest: 1789635935872n }, { lastRequest: 1789635935872 }]);
  for (const row of rows) assert.equal(row.lastRequest, 1789635935872);
  assert.equal(rows[0].other, original.other);
  assert.equal(original.lastRequest, '1789635935872');
  assert.deepEqual(await transform('ba_user', [original]), [original]);
  assert.deepEqual(await transform('ba_rate_limit', [{ count: 3 }]), [{ count: 3 }]);
});

test('auth database: malformed or unsafe timestamps fail closed', async () => {
  for (const lastRequest of ['bad', '', null, -1, '9007199254740993', Infinity, 1.2]) {
    await assert.rejects(() => transform('ba_rate_limit', [{ lastRequest }]), /invalid_rate_limit_timestamp/);
  }
});
