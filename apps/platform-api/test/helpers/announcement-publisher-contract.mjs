import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { changeAnnouncement, readAnnouncements, readUserAnnouncements } from '../../src/announcements/store.mjs';
import { publisherTick } from '../../src/announcements/publisher-store.mjs';

export async function publisherContract(t, f) {
  const create = async (extra = {}) => (await changeAnnouncement(f.store, 'admin', { action: 'create', requestId: randomUUID(), title: 'scheduled', body: 'private body', ...extra })).announcement;
  const schedule = async (extra = {}) => {
    const draft = await create(extra);
    return (await changeAnnouncement(f.store, 'admin', { action: 'schedule', id: draft.id, expectedVersion: draft.version, requestId: randomUUID(), scheduledAt: new Date(f.now() + 60000).toISOString() })).announcement;
  };
  const get = async item => (await readAnnouncements(f.store, 'second', { id: item.id })).announcement;
  const tick = (options = {}) => publisherTick(f.publisherStore ?? f.store, { now: f.now, ...options });
  await t.test('clock decides visibility; first due tick publishes once with system audit and no user fanout', async () => {
    const item = await schedule();
    assert.equal((await tick()).processed, 0);
    assert.equal((await readUserAnnouncements(f.store, { userId: 'user', organizationId: 'org-user' }, { id: item.id })).error, 'not_found');
    await f.due(item.id);
    const result = await tick();
    assert.equal(result.published, 1);
    assert.deepEqual(Object.keys(result).sort(), ['processed','published','expired','blocked','failed','pending','maxDelaySeconds','blockedTotal'].sort());
    assert.equal((await tick()).published, 0);
    const current = await get(item);
    assert.equal(current.status, 'published'); assert.ok(current.publishedAt);
    const events = (await readAnnouncements(f.store, 'second', { id: item.id, audit: true })).items;
    const publication = events.filter(e => e.action === 'published');
    assert.equal(publication.length, 1); assert.equal(publication[0].executorType, 'system');
    assert.equal(publication[0].actorUserId, 'admin'); assert.ok(publication[0].executorId);
    assert.equal(publication[0].scheduleGovernanceVersion, item.scheduleGovernanceVersion);
    assert.equal(await f.receipts(), 0);
  });
  await t.test('overdue unpublished item expires without ever becoming visible; published history survives expiry', async () => {
    const item = await schedule(); await f.due(item.id, true);
    assert.equal((await tick()).expired, 1);
    assert.equal((await get(item)).publishedAt, null);
    assert.equal((await readUserAnnouncements(f.store, { userId: 'user', organizationId: 'org-user' }, { id: item.id, history: true })).error, 'not_found');
    const published = await schedule(); await f.due(published.id); await tick(); await f.expire(published.id);
    assert.equal((await tick()).expired, 1);
    const historical = await readUserAnnouncements(f.store, { userId: 'user', organizationId: 'org-user' }, { id: published.id, history: true });
    assert.equal(historical.announcement.status, 'expired'); assert.ok(historical.announcement.publishedAt);
  });
  for (const reason of ['governance', 'generation', 'revoke', 'role']) await t.test(reason + ' blocks persistently; restore requires cancel and a new schedule', async () => {
    const item = await schedule(); await f.due(item.id); await f.restrict(reason, true);
    assert.equal((await tick()).blocked, 1);
    let current = await get(item);
    assert.equal(current.status, 'scheduled'); assert.equal(current.publishBlocked, true);
    assert.equal(current.lastPublishError, 'publisher_authorization_changed');
    assert.deepEqual((await readAnnouncements(f.store, 'second', { id: item.id, audit: true })).items.find(e => e.action === 'publish_blocked').changedFields, ['publishBlocked']);
    await f.restrict(reason, false);
    assert.equal((await tick()).published, 0);
    current = await get(item);
    const cancelled = (await changeAnnouncement(f.store, 'second', { action: 'cancel', id: item.id, expectedVersion: current.version, requestId: randomUUID() })).announcement;
    assert.equal(cancelled.publishBlocked, false); assert.equal(cancelled.lastPublishError, null);
    assert.equal(cancelled.publishAttempts, 0); assert.equal(cancelled.nextPublishAttemptAt, null);
    const again = (await changeAnnouncement(f.store, 'admin', { action: 'schedule', id: item.id, expectedVersion: cancelled.version, requestId: randomUUID(), scheduledAt: new Date(f.now() + 60000).toISOString() })).announcement;
    await f.due(again.id); assert.equal((await tick()).published, 1);
  });
  await t.test('audit failure rolls back publication; retry metadata is safe and later items are not starved', async () => {
    const first = await schedule(); await f.due(first.id); await f.failAudit(first.id, true);
    assert.equal((await tick({ limit: 1 })).failed, 1);
    const failed = await get(first);
    assert.equal(failed.status, 'scheduled'); assert.equal(failed.publishedAt, null);
    assert.equal(failed.lastPublishError, 'publisher_item_failed'); assert.equal(failed.publishAttempts, 1); assert.ok(failed.nextPublishAttemptAt);
    assert.equal((await readAnnouncements(f.store, 'second', { id: first.id, audit: true })).items.filter(e => e.action === 'published').length, 0);
    const later = await schedule(); await f.due(later.id);
    assert.equal((await tick({ limit: 1 })).published, 1);
    await f.failAudit(first.id, false); await f.retry(first.id);
    assert.equal((await tick()).published, 1);
    assert.equal((await get(first)).lastPublishError, null);
  });
  await t.test('role revoke and restore before the first tick cannot revive the old scheduled authorization', async () => {
    const a = await schedule(); await f.due(a.id);
    await f.restrict('revoke', true); await f.restrict('revoke', false);
    const result = await tick(); assert.equal(result.blocked, 1); assert.equal(result.published, 0);
    assert.equal((await get(a)).publishBlocked, true);
  });
  await t.test('failed block audit keeps the authorization fence after role restoration and retries only the audit', async () => {
    const a = await schedule(); await f.due(a.id); await f.failAudit(a.id, true); await f.restrict('revoke', true);
    assert.equal((await tick()).failed, 1);
    let item = await get(a); assert.equal(item.publishBlocked, true); assert.equal(item.publishedAt, null);
    await f.restrict('revoke', false); await f.failAudit(a.id, false); await f.retry(a.id);
    const result = await tick(); assert.equal(result.blocked, 1); assert.equal(result.published, 0);
    item = await get(a); assert.equal(item.publishBlocked, true); assert.equal(item.lastPublishError, 'publisher_authorization_changed');
    assert.equal((await readAnnouncements(f.store, 'second', { id: a.id, audit: true })).items.filter(e => e.action === 'publish_blocked').length, 1);
    assert.equal((await tick()).published, 0);
  });
  await t.test('item retry delay increases exponentially and is capped at five minutes', async () => {
    const a = await schedule(); await f.due(a.id); await f.failAudit(a.id, true);
    for (let attempt = 1; attempt <= 8; attempt++) {
      if (attempt > 1) await f.retry(a.id);
      const started = f.now(); assert.equal((await tick()).failed, 1);
      const item = await get(a), delay = Date.parse(item.nextPublishAttemptAt) - started;
      assert.equal(item.publishAttempts, attempt);
      const expected = Math.min(300000, 5000 * 2 ** (attempt - 1));
      assert.ok(delay >= expected && delay < expected + 2000, `delay ${delay} expected ${expected}`);
    }
    await f.failAudit(a.id, false); await f.retry(a.id); assert.equal((await tick()).published, 1);
  });
  await t.test('tick rejects unbounded batches before touching either store', async () => {
    for (const limit of [0, -1, 51, 1.5, '2', null]) await assert.rejects(tick({ limit }), { code: 'invalid_publisher_limit' });
  });
}
