import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { changeAnnouncement, readAnnouncements, readUserAnnouncements, markAnnouncementRead } from '../../src/announcements/store.mjs';

export async function announcementContract(t, f) {
  const { store, admin, second, viewer, operator, user, other, scope, otherScope, now } = f;
  const change = (input, actor = admin) => changeAnnouncement(store, actor, input, { now });
  const create = (extra = {}) => change({ action: 'create', requestId: randomUUID(), title: '平台维护', body: '第一行\n第二行', ...extra });
  const update = (announcement, action, extra = {}) => change({ action, id: announcement.id, expectedVersion: announcement.version, requestId: randomUUID(), ...extra });

  await t.test('create normalizes content, keeps default expiry policy and records immutable audit', async () => {
    const result = await create({ title: '  公告 😀  ', body: '  正文\n说明  ' });
    assert.equal(result.announcement.title, '公告 😀');
    assert.equal(result.announcement.body, '正文\n说明');
    assert.equal(result.announcement.status, 'draft');
    assert.equal(result.announcement.version, 1);
    assert.equal(result.announcement.expiresAt, null);
    assert.equal(result.announcement.expiryDays, 30);
    const audit = await readAnnouncements(store, admin, { id: result.announcement.id, audit: true });
    assert.equal(audit.items[0].action, 'created');
    assert.equal(audit.items[0].actorUserId, admin);
    assert.match(audit.items[0].contentHash, /^[0-9a-f]{64}$/);
    assert.equal(audit.items[0].contentHash, createHash('sha256').update('公告 😀\n正文\n说明').digest('hex'));
    assert.equal('body' in audit.items[0], false);
    result.announcement.title = 'mutated response';
    assert.equal((await readAnnouncements(store, admin, { id: result.announcement.id })).announcement.title, '公告 😀');
  });

  await t.test('only explicit active platform admins can write; viewers/operators read', async () => {
    const item = (await create()).announcement;
    for (const actor of [viewer, operator]) {
      assert.ok((await readAnnouncements(store, actor, {})).items.length);
      assert.equal((await createFor(actor)).error, 'platform_role_required');
    }
    for (const actor of [user, other, 'missing-user']) {
      assert.equal((await readAnnouncements(store, actor, {})).error, 'platform_role_required');
      assert.equal((await createFor(actor)).error, 'platform_role_required');
    }
    await f.govern(admin, 'suspended');
    assert.equal((await update(item, 'publish')).error, 'platform_role_required');
    assert.equal((await readAnnouncements(store, admin, {})).error, 'platform_role_required');
    await f.govern(admin, 'active');
    await f.revoke(admin, true);
    assert.equal((await update(item, 'publish')).error, 'platform_role_required');
    await f.revoke(admin, false);
    async function createFor(actor) { return change({ action: 'create', requestId: randomUUID(), title: 'a', body: 'b' }, actor); }
  });

  await t.test('request replay is atomic, cross-action conflicts and revoked actors cannot replay', async () => {
    const command = { action: 'create', requestId: randomUUID(), title: '幂等公告', body: 'b' };
    const [a, b] = await Promise.all([change(command), change(command)]);
    assert.equal(a.announcement.id, b.announcement.id);
    assert.equal([a, b].filter(x => x.replayed).length, 1);
    assert.equal((await change({ ...command, body: 'different' })).error, 'idempotency_conflict');
    assert.equal((await change({ ...command, action: 'publish', id: a.announcement.id, expectedVersion: 1, title: undefined, body: undefined })).error, 'invalid_announcement_input');
    assert.equal((await change({ action: 'publish', id: a.announcement.id, expectedVersion: 1, requestId: command.requestId })).error, 'idempotency_conflict');
    await update(a.announcement, 'edit', { title: 'new', body: 'changed' });
    assert.equal((await change(command)).announcement.version, 1);
    const audit = await readAnnouncements(store, admin, { id: a.announcement.id, audit: true });
    assert.deepEqual(audit.items.map(x => x.action), ['draft_updated', 'created']);
    await f.revoke(admin, true);
    assert.equal((await change(command)).error, 'platform_role_required');
    await f.revoke(admin, false);
  });

  await t.test('immediate publication is immutable, version fenced and visible with default expiry', async () => {
    const draft = (await create()).announcement;
    assert.equal((await readUserAnnouncements(store, scope, { id: draft.id })).error, 'not_found');
    const published = (await update(draft, 'publish')).announcement;
    assert.equal(published.status, 'published');
    assert.equal(Date.parse(published.expiresAt) - Date.parse(published.publishedAt), 30 * 86400000);
    assert.equal((await update(draft, 'publish')).error, 'version_conflict');
    assert.equal((await update(published, 'edit', { title: 'x', body: 'y' })).error, 'invalid_announcement_state');
    const visible = (await readUserAnnouncements(store, scope, { id: published.id })).announcement;
    assert.equal(visible.body, published.body);
    for (const key of ['createdBy', 'scheduledBy', 'scheduleGovernanceVersion', 'requestId']) assert.equal(key in visible, false);
    const withdrawn = (await update(published, 'withdraw', { reason: '  内容纠错  ' })).announcement;
    assert.equal(withdrawn.status, 'withdrawn');
    assert.equal((await readUserAnnouncements(store, scope, { id: published.id, history: true })).error, 'not_found');
    assert.equal((await update(withdrawn, 'publish')).error, 'invalid_announcement_state');
  });

  await t.test('schedule stores intent only, cancellation enables editing and scheduling requires future time', async () => {
    const draft = (await create({ expiresAt: null })).announcement;
    const scheduledAt = new Date(now() + 3600000).toISOString();
    const scheduled = (await update(draft, 'schedule', { scheduledAt })).announcement;
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(Date.parse(scheduled.scheduledAt), Date.parse(scheduledAt));
    assert.equal(scheduled.scheduledBy, admin);
    assert.equal(scheduled.publishedAt, null);
    assert.equal((await readUserAnnouncements(store, scope, { id: scheduled.id })).error, 'not_found');
    assert.equal((await update(scheduled, 'edit', { title: 'x', body: 'y' })).error, 'invalid_announcement_state');
    const cancelled = (await update(scheduled, 'cancel')).announcement;
    assert.equal(cancelled.status, 'draft');
    assert.equal(cancelled.scheduledAt, null);
    assert.equal(cancelled.scheduledBy, null);
    assert.equal((await update(cancelled, 'schedule', { scheduledAt: new Date(now() - 3600000).toISOString() })).error, 'invalid_announcement_time');
    const published = (await update(cancelled, 'publish')).announcement;
    assert.equal(published.expiresAt, null);
  });

  await t.test('two editors racing on one version cannot lose updates', async () => {
    const draft = (await create()).announcement;
    const results = await Promise.all([admin, second].map(actor => change({ action: 'edit', id: draft.id, expectedVersion: 1, requestId: randomUUID(), title: actor, body: 'race' }, actor)));
    assert.equal(results.filter(x => x.announcement).length, 1);
    assert.equal(results.filter(x => x.error === 'version_conflict').length, 1);
    assert.equal((await readAnnouncements(store, admin, { id: draft.id, audit: true })).items.length, 2);
  });

  await t.test('personal receipts are isolated, idempotent and suspended accounts remain read only', async () => {
    const published = (await update((await create()).announcement, 'publish')).announcement;
    const before = await readUserAnnouncements(store, scope, {});
    const a = await markAnnouncementRead(store, scope, published.id);
    const b = await markAnnouncementRead(store, scope, published.id);
    assert.equal(a.unreadCount, before.unreadCount - 1);
    assert.equal(b.unreadCount, a.unreadCount);
    assert.equal((await readUserAnnouncements(store, scope, { id: published.id })).announcement.isRead, true);
    assert.equal((await readUserAnnouncements(store, otherScope, { id: published.id })).announcement.isRead, false);
    assert.equal((await markAnnouncementRead(store, { ...scope, organizationId: otherScope.organizationId }, published.id)).error, 'not_found');
    await f.govern(user, 'suspended');
    assert.ok((await readUserAnnouncements(store, scope, {})).items);
    assert.equal((await markAnnouncementRead(store, scope, published.id)).error, 'account_read_only');
    await f.govern(user, 'banned');
    assert.equal((await readUserAnnouncements(store, scope, {})).error, 'account_banned');
    await f.govern(user, 'active');
  });

  await t.test('expiry excludes unread and detail by clock while explicit history retains content', async () => {
    const published = (await update((await create({ expiresAt: new Date(now() + 60000).toISOString() })).announcement, 'publish')).announcement;
    const before = await readUserAnnouncements(store, scope, {});
    await f.expire(published.id);
    assert.equal((await readUserAnnouncements(store, scope, { id: published.id })).error, 'not_found');
    assert.equal((await readUserAnnouncements(store, scope, { id: published.id, history: true })).announcement.status, 'expired');
    assert.equal((await markAnnouncementRead(store, scope, published.id)).error, 'not_found');
    const after = await readUserAnnouncements(store, scope, {});
    assert.equal(after.items.some(x => x.id === published.id), false);
    assert.equal(after.unreadCount, before.unreadCount - 1);
    await f.materializeExpired(published.id);
    assert.equal((await readUserAnnouncements(store, scope, { id: published.id, history: true })).announcement.status, 'expired');
  });

  await t.test('audit cursor is descending, complete and excludes fields outside the audit projection', async () => {
    let item = (await create()).announcement;
    for (let n = 0; n < 3; n++) item = (await update(item, 'edit', { title: 'revision ' + n, body: 'audit revision' })).announcement;
    const first = await readAnnouncements(store, viewer, { id: item.id, audit: true, limit: 2 });
    const secondPage = await readAnnouncements(store, viewer, { id: item.id, audit: true, after: first.nextCursor, limit: 2 });
    assert.deepEqual([...first.items, ...secondPage.items].map(row => row.version), [4, 3, 2, 1]);
    assert.equal(secondPage.nextCursor, null);
    for (const row of [...first.items, ...secondPage.items]) {
      assert.equal('input' in row, false);
      assert.deepEqual(row.changedFields, [...row.changedFields].sort());
    }
  });

  await t.test('bounded stable pagination, audit pagination and invalid inputs fail closed', async () => {
    const first = await readAnnouncements(store, viewer, { limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const next = await readAnnouncements(store, viewer, { limit: 1, after: first.nextCursor });
    assert.notEqual(first.items[0].id, next.items[0].id);
    const audit = await readAnnouncements(store, viewer, { id: first.items[0].id, audit: true, limit: 1 });
    assert.equal(audit.items.length, 1);
    for (const input of [{ title: '' }, { body: '' }, { title: 'a'.repeat(121) }, { body: 'a'.repeat(20001) }, { body: 'x\u0000' }, { title: 'x\n' }, { pinned: 'true' }, { severity: 'danger' }, { expiresAt: '2026-01-01' }, { actorUserId: second }, { requestId: 'bad' }]) {
      assert.equal((await create(input)).error, 'invalid_announcement_input', JSON.stringify(input).slice(0, 100));
    }
    assert.ok((await create({ title: '😀'.repeat(120) })).announcement);
    for (const query of [{ limit: 0 }, { limit: 101 }, { after: 'invalid' }, { unexpected: true }, { status: 'invented' }]) assert.equal((await readAnnouncements(store, admin, query)).error, 'invalid_announcement_query');
    assert.equal((await update((await create()).announcement, 'withdraw', { reason: ' ' })).error, 'invalid_announcement_input');
  });

  await t.test('title search is server-side, cursor bounded and never matches body-only terms', async () => {
    await create({ title: 'SearchNeedle Alpha', body: 'body' });
    await create({ title: 'SearchNeedle Beta', body: 'body' });
    await create({ title: 'unrelated title', body: 'SearchNeedle' });
    const first = await readAnnouncements(store, viewer, { q: 'searchneedle', limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const secondPage = await readAnnouncements(store, viewer, { q: 'searchneedle', limit: 1, after: first.nextCursor });
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(first.items[0].id, secondPage.items[0].id);
    assert.equal(secondPage.nextCursor, null);
    for (const q of [null, 5, 'x'.repeat(201), 'x\n']) assert.equal((await readAnnouncements(store, viewer, { q })).error, 'invalid_announcement_query');
  });

  await t.test('saved indefinite drafts can atomically return to publication-relative default expiry', async () => {
    const draft = (await create({ expiresAt: null })).announcement;
    const reset = await update(draft, 'edit', { title: '恢复默认到期', body: 'body', expiryDays: 30 });
    assert.ok(reset.announcement);
    assert.equal(reset.announcement.expiryDays, 30);
    assert.equal(reset.announcement.expiresAt, null);
    const published = (await update(reset.announcement, 'publish')).announcement;
    assert.equal(Date.parse(published.expiresAt) - Date.parse(published.publishedAt), 30 * 86400000);
    const conflict = await create({ expiryDays: 30, expiresAt: null });
    assert.equal(conflict.error, 'invalid_announcement_input');
    assert.equal((await create({ expiryDays: 7 })).error, 'invalid_announcement_input');
  });
}
