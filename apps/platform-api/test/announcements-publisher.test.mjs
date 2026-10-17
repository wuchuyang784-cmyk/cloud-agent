import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MemoryStore } from '../src/store.mjs';
import { publisherTick } from '../src/announcements/publisher-store.mjs';
import { publisherContract } from './helpers/announcement-publisher-contract.mjs';

test('announcement publisher export exists', () => assert.equal(typeof publisherTick, 'function'));
test('checked-out publisher client errors are handled, sanitized and discarded even when rollback succeeds', async () => {
  const client = new EventEmitter(), calls = [], releases = [], disconnect = new Error('private database password and SQL');
  let errorListeners;
  client.query = async sql => {
    calls.push(sql);
    if (sql.startsWith('SELECT')) { errorListeners=client.listenerCount('error'); client.emit('error', disconnect); throw disconnect; }
    return { rows: [] };
  };
  client.release = error => releases.push(error);
  await assert.rejects(publisherTick({ pool: { async connect() { return client; } } }), error =>
    error.code === 'announcement_publisher_unavailable' && !error.message.includes('private'));
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(errorListeners,1);
  assert.ok(releases[0], 'broken connection must be discarded even after a confirmed rollback');
  assert.equal(client.listenerCount('error'), 0);
});
test('announcement publisher MemoryStore contract', async t => {
  assert.equal(typeof publisherTick, 'function');
  const store = new MemoryStore({ seed: { users: ['admin', 'second', 'user'].map(id => ({ id, email: id + '@example.test', organizationId: 'org-' + id, role: 'org_admin' })) } });
  store.platformRoles = new Map(['admin', 'second'].map(id => [id, { role: 'platform_admin', revokedAt: null }]));
  store.accountGovernance = new Map();
  let clock = Date.parse('2026-10-16T00:00:00Z'); store.announcementNow = () => clock;
  const audit = []; let failId;
  audit.push = function (...entries) { if (entries.some(e => e.announcementId === failId && e.executorType === 'system')) throw new Error('secret audit failure'); return Array.prototype.push.apply(this, entries); };
  store.announcementAudit = audit;
  await publisherContract(t, { store, now: () => clock,
    async due(id, expired) { const item = store.announcements.get(id); item.scheduledAt = new Date(clock - 10000).toISOString(); if (expired) item.expiresAt = new Date(clock - 1000).toISOString(); },
    async expire(id) { const a = store.announcements.get(id); a.publishedAt = new Date(clock - 2000).toISOString(); a.expiresAt = new Date(clock - 1000).toISOString(); },
    async restrict(reason, on) {
      if (['governance','generation'].includes(reason)) store.accountGovernance.set('admin', { status: reason === 'governance' && on ? 'suspended' : 'active', version: (store.accountGovernance.get('admin')?.version ?? 0) + 1 });
      else {
        const binding = store.platformRoles.get('admin'); binding.revision = (binding.revision ?? 0) + 1;
        if (reason === 'role') binding.role = on ? 'platform_viewer' : 'platform_admin'; else binding.revokedAt = on ? '2026-10-16T00:00:00Z' : null;
      }
    },
    async failAudit(id, on) { failId = on ? id : null; }, async retry(id) { clock = Date.parse(store.announcements.get(id).nextPublishAttemptAt) + 1; },
    async receipts() { return store.announcementReceipts.size; },
  });
});
