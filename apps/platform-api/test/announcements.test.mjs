import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../src/store.mjs';
import { announcementContract } from './helpers/announcements-contract.mjs';
import { announcementTime, normalizeCommand, normalizeQuery } from '../src/announcements/validation.mjs';
import { announcementQuery } from '../src/announcements/postgres.mjs';

test('validation rejects invalid calendars, non-string audit cursors and wrong JSON types', () => {
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-16T24:00:00Z', '2026-10-16T00:00:00', '2026-10-16T00:00:00+14:30', '2026-10-16', '0000-01-01T00:00:00Z', '9999-12-31T23:59:59-14:00']) assert.equal(announcementTime(value), null, value);
  assert.equal(announcementTime('2026-10-16T08:00:00+08:00'), '2026-10-16T00:00:00.000Z');
  const id = randomUUID();
  assert.equal(normalizeQuery({ id, audit: true, after: 1 }), null);
  assert.equal(normalizeCommand({ action: 'create', requestId: id, title: 'a', body: 'x\r\ny' }), null);
  for (const query of [{ status: null }, { limit: null }, { id: null }, { after: null }, { audit: null }]) assert.equal(normalizeQuery(query), null);
});

for (const brokenRollback of [false, true]) test('PG adapter sanitizes failures and ' + (brokenRollback ? 'discards uncertain connection' : 'releases confirmed rollback'), async () => {
  const rollback = new Error('rollback_failure'), calls = [], releases = [];
  const client = { async query(sql) { calls.push(sql); if (sql.startsWith('SELECT')) throw new Error('private SQL body secret'); if (sql === 'ROLLBACK' && brokenRollback) throw rollback; return { rows: [] }; }, release(error) { releases.push(error); } };
  await assert.rejects(announcementQuery({ pool: { async connect() { return client; } } }, 'change', ['actor', {}]), error => error.code === 'announcements_unavailable' && !error.message.includes('secret'));
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.deepEqual(releases, [brokenRollback ? rollback : undefined]);
});

test('PG adapter sanitizes connection checkout failure and commits before releasing success', async () => {
  await assert.rejects(announcementQuery({ pool: { async connect() { throw new Error('private connection string'); } } }, 'read', []), { code: 'announcements_unavailable' });
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return { rows: [{ result: { items: [] } }] }; }, release() { calls.push('release'); } };
  assert.deepEqual(await announcementQuery({ pool: { async connect() { return client; } } }, 'read', ['actor', {}]), { items: [] });
  assert.deepEqual(calls.slice(-2), ['COMMIT', 'release']);
});

test('announcements MemoryStore contract', async t => {
  const store = new MemoryStore({ seed: { users: ['admin', 'second', 'viewer', 'operator', 'user', 'other'].map(id => ({ id, email: id + '@example.test', organizationId: 'org-' + id, role: 'org_admin' })) } });
  store.platformRoles = new Map(['admin', 'second', 'viewer', 'operator'].map(id => [id, { role: 'platform_' + (id === 'second' ? 'admin' : id), revokedAt: null }]));
  store.accountGovernance = new Map();
  let clock = Date.parse('2026-10-16T00:00:00Z');
  const now = () => clock;
  store.announcementNow = now;
  await announcementContract(t, { store, admin: 'admin', second: 'second', viewer: 'viewer', operator: 'operator', user: 'user', other: 'other', now,
    scope: { organizationId: 'org-user', userId: 'user' }, otherScope: { organizationId: 'org-other', userId: 'other' },
    async govern(id, status) { store.accountGovernance.set(id, { status, version: (store.accountGovernance.get(id)?.version ?? 0) + 1 }); },
    async revoke(id, value) { store.platformRoles.get(id).revokedAt = value ? new Date(clock).toISOString() : null; },
    async expire(id) { clock = Date.parse(store.announcements.get(id).expiresAt) + 1; },
    async materializeExpired(id) { store.announcements.get(id).status = 'expired'; },
  });
});
