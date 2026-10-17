import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { changeAnnouncement } from '../../src/announcements/store.mjs';

export async function notificationCenterContract(t, f, api) {
  const { store, scope, otherScope } = f;
  const publish = async (extra = {}) => {
    const draft = await changeAnnouncement(store, 'admin', { action: 'create', requestId: randomUUID(), title: '公告', body: '😀'.repeat(300), ...extra });
    return (await changeAnnouncement(store, 'admin', { action: 'publish', requestId: randomUUID(), id: draft.announcement.id, expectedVersion: 1 })).announcement;
  };
  await t.test('shared announcements join only own notifications; pinned ordering, bounded summaries and global unread', async () => {
    const first = await publish({ pinned: true });
    await publish();
    await store.addNotification(scope, { title: '本人', type: 'billing', body: 'body' });
    await store.addNotification(otherScope, { title: '他人' });
    const result = await api.readNotificationCenter(store, scope, { limit: 1 });
    assert.equal(result.notifications[0].id, 'announcement:' + first.id);
    assert.equal([...result.notifications[0].body].length, 240);
    assert.equal(result.unreadCount, 3);
    assert.ok(result.nextCursor);
    assert.equal('organizationId' in result.notifications[0], false);
    const filtered = await api.readNotificationCenter(store, scope, { source: 'notification', read: 'read' });
    assert.equal(filtered.notifications.length, 0);
    assert.equal(filtered.unreadCount, 3);
    const rows = []; let after;
    do { const page = await api.readNotificationCenter(store, scope, { limit: 1, ...(after ? { after } : {}) }); rows.push(...page.notifications); after = page.nextCursor; } while (after);
    assert.equal(rows.length, 3); assert.equal(new Set(rows.map(x => x.id)).size, 3);
  });
  await t.test('normal receipt is scoped, repeatable, and announcement receipts stay independent', async () => {
    const own = await store.addNotification(scope, { title: 'read' });
    const foreign = await store.addNotification(otherScope, { title: 'foreign' });
    assert.equal((await api.markCenterNotificationRead(store, scope, foreign.id)).error, 'not_found');
    assert.equal((await api.markCenterNotificationRead(store, scope, own.id)).updated, 1);
    assert.equal((await api.markCenterNotificationRead(store, scope, own.id)).updated, 0);
    const item = await publish();
    await api.markCenterNotificationRead(store, scope, 'announcement:' + item.id);
    assert.equal((await api.readNotificationCenter(store, otherScope, { source: 'announcement', read: 'unread' })).notifications.some(x => x.referenceId === item.id), true);
  });
  await t.test('read-all snapshots both sources once; duplicate and later replay cannot consume new rows', async () => {
    const requestId = randomUUID();
    const results = await Promise.all([api.markNotificationCenterRead(store, scope, requestId), api.markNotificationCenterRead(f.secondStore ?? store, scope, requestId)]);
    assert.equal(results.filter(x => x.replayed).length, 1);
    assert.equal(results[0].unreadCount, 0);
    const item = await publish(); await store.addNotification(scope, { title: 'new' });
    const replay = await api.markNotificationCenterRead(store, scope, requestId);
    assert.equal(replay.replayed, true); assert.equal(replay.unreadCount, 2);
    assert.equal((await api.readNotificationCenter(store, scope, { read: 'unread' })).notifications.some(x => x.referenceId === item.id), true);
    assert.equal((await api.markNotificationCenterRead(store, otherScope, requestId)).replayed, false);
  });
  await t.test('expiry, history, withdrawn, draft and scheduled visibility use effective clock', async () => {
    const expired = await publish({ pinned: true }); await f.expire(expired.id);
    const withdrawn = await publish();
    await changeAnnouncement(store, 'admin', { action: 'withdraw', requestId: randomUUID(), id: withdrawn.id, expectedVersion: 2, reason: '撤回' });
    for (const action of ['draft', 'scheduled']) {
      const draft = (await changeAnnouncement(store, 'admin', { action: 'create', requestId: randomUUID(), title: action, body: 'body' })).announcement;
      if (action === 'scheduled') await changeAnnouncement(store, 'admin', { action: 'schedule', requestId: randomUUID(), id: draft.id, expectedVersion: 1, scheduledAt: new Date(Date.now() + 3600000).toISOString() });
      assert.equal((await api.readNotificationCenter(store, scope, { history: true })).notifications.some(x => x.referenceId === draft.id), false);
    }
    assert.equal((await api.readNotificationCenter(store, scope)).notifications.some(x => x.referenceId === expired.id), false);
    const history = (await api.readNotificationCenter(store, scope, { history: true })).notifications;
    assert.equal(history.find(x => x.referenceId === expired.id).pinned, false);
    assert.equal(history.find(x => x.referenceId === expired.id).status, 'expired');
    assert.equal(history.some(x => x.referenceId === withdrawn.id), false);
    const unreadHistory = await api.readNotificationCenter(store, scope, { history: true, read: 'unread' });
    assert.equal(unreadHistory.notifications.some(x => x.referenceId === expired.id), false, 'expired history must not create an unread backlog');
    assert.ok(unreadHistory.notifications.every(x => x.status === 'published' && !x.isRead));
  });
  await t.test('scope, governance and query inputs fail closed', async () => {
    assert.equal((await api.readNotificationCenter(store, { ...scope, organizationId: otherScope.organizationId })).error, 'not_found');
    for (const q of [{ source: null }, { userId: 'other' }, { limit: 101 }, { limit: '2' }, { history: 'true' }, { read: 'bad' }, { after: 'bad' }]) assert.equal((await api.readNotificationCenter(store, scope, q)).error, 'invalid_notification_query');
    await f.govern('user', 'suspended');
    assert.ok((await api.readNotificationCenter(store, scope)).notifications);
    assert.equal((await api.markNotificationCenterRead(store, scope, randomUUID())).error, 'account_read_only');
    await f.govern('user', 'banned');
    assert.equal((await api.readNotificationCenter(store, scope)).error, 'account_banned');
    await f.govern('user', 'active');
  });
}
