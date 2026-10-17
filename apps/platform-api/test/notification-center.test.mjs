import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store.mjs';
import { notificationCenterContract } from './helpers/notification-center-contract.mjs';
import { normalizeNotificationQuery } from '../src/announcements/notifications.mjs';

test('notification cursors reject impossible calendar dates and mismatched filters', () => {
  const encode = values => Buffer.from(JSON.stringify(values)).toString('base64url');
  for (const time of ['2026-02-30T00:00:00.000000Z', '2026-10-16T24:00:00.000000Z', '0000-01-01T00:00:00.000000Z']) assert.equal(normalizeNotificationQuery({ after: encode(['all', 'all', false, false, time, 'notification', 'notify-a']) }), null);
  assert.equal(normalizeNotificationQuery({ source: 'announcement', after: encode(['all', 'all', false, false, '2026-10-16T00:00:00.123456Z', 'notification', 'notify-a']) }), null);
});

test('notification center Memory contract', async t => {
  const api = await import('../src/announcements/notifications.mjs').catch(() => ({}));
  assert.equal(typeof api.readNotificationCenter, 'function', 'notification center reader is available');
  const store = new MemoryStore({ seed: { users: ['admin', 'user', 'other'].map(id => ({ id, email: id + '@example.test', organizationId: 'org-' + id, role: 'org_admin' })) } });
  store.platformRoles = new Map([['admin', { role: 'platform_admin' }]]);
  store.accountGovernance = new Map();
  await notificationCenterContract(t, { store, scope: { organizationId: 'org-user', userId: 'user' }, otherScope: { organizationId: 'org-other', userId: 'other' },
    async expire(id) { const item = store.announcements.get(id); item.publishedAt = new Date(Date.now() - 2000).toISOString(); item.expiresAt = new Date(Date.now() - 1000).toISOString(); },
    async govern(id, status) { store.accountGovernance.set(id, { status }); },
  }, api);
});
