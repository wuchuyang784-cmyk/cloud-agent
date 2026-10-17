import test from 'node:test';
import assert from 'node:assert/strict';
import { NotificationSession, watchNotifications } from '../src/notification-state.ts';

const scope = { userId: 'alice', organizationId: 'alice-space', accountStatus: 'active' };
const row = (patch = {}) => ({ id: 'announcement:11111111-1111-4111-8111-111111111111', referenceId: '11111111-1111-4111-8111-111111111111', source: 'announcement', type: 'announcement', title: 'Notice', body: 'summary', createdAt: '2026-10-16T00:00:00Z', readAt: null, isRead: false, pinned: false, severity: 'normal', status: 'published', expiresAt: null, ...patch });
const page = (count = 2, rows = [row()], nextCursor = null) => ({ notifications: rows, unreadCount: count, nextCursor });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const httpError = (status, code = '') => Object.assign(new Error('internal details must not show'), { status, code });
function fixture(override, options = {}) {
  const calls = [];
  const transport = async (path, init) => {
    calls.push({ path, init });
    if (override) { const value = await override(path, init); if (value !== undefined) return value; }
    if (init?.method) return { ok: true, updated: 1, unreadCount: 1, isRead: true };
    if (path.startsWith('/api/user/announcements/')) return { announcement: { ...row(), id: row().referenceId, body: 'full plain text', publishedAt: row().createdAt }, unreadCount: 2 };
    return page();
  };
  return { model: new NotificationSession(transport, options), calls };
}

test('notification failure is unknown unread, not fabricated empty/zero, and recovery uses authoritative count', async () => {
  let fail = false;
  const { model } = fixture(() => { if (fail) throw httpError(503); });
  await model.activate(scope); assert.equal(model.getSnapshot().unreadCount, 2);
  fail = true; await model.refresh();
  assert.equal(model.getSnapshot().phase, 'error'); assert.equal(model.getSnapshot().unreadCount, null);
  assert.ok(model.getSnapshot().updatedAt); assert.doesNotMatch(model.getSnapshot().error, /internal/);
  fail = false; await model.refresh(); assert.equal(model.getSnapshot().unreadCount, 2);
});

test('reset and account switch abort and fence late results, including abort-ignoring transports', async () => {
  const delayed = deferred(); let signal;
  const { model } = fixture((_, init) => { signal = init.signal; return delayed.promise; });
  const pending = model.activate(scope); model.reset(); assert.equal(signal.aborted, true);
  delayed.resolve(page()); await pending; assert.deepEqual(model.getSnapshot().items, []);
  const next = fixture(); await next.model.activate(scope);
  await next.model.activate({ ...scope, userId: 'bob', organizationId: 'bob-space' });
  assert.equal(next.model.getSnapshot().identityKey, 'bob-space:bob');
});

test('announcement detail loads before marking, and both read and later refresh counts come from server', async () => {
  const { model, calls } = fixture(); await model.activate(scope); await model.open(row());
  const detail = calls.findIndex(call => call.path.startsWith('/api/user/announcements/'));
  const mark = calls.findIndex(call => call.path.endsWith('/read'));
  assert.ok(detail > 0 && mark > detail); assert.equal(model.getSnapshot().detail.item.body, 'full plain text');
  // A concurrent new notification may make the subsequent authoritative list count larger again.
  assert.equal(model.getSnapshot().unreadCount, 2); assert.equal(model.getSnapshot().pending, null);
});

test('failed, withdrawn or expired detail never sends a read and clears old body', async () => {
  for (const missing of [true, false]) {
    const { model, calls } = fixture(path => {
      if (path.startsWith('/api/user/announcements/')) {
        if (missing) throw httpError(404);
        return { announcement: { ...row(), id: row().referenceId, body: 'expired body', status: 'expired', publishedAt: row().createdAt }, unreadCount: 0 };
      }
    });
    await model.activate(scope); await model.open(row());
    assert.equal(calls.filter(call => call.init?.method).length, 0);
    if (missing) { assert.equal(model.getSnapshot().detail.phase, 'missing'); assert.equal(model.getSnapshot().detail.item, null); assert.equal(model.getSnapshot().unreadCount, null); }
  }
});

test('suspended identities read full announcements but cannot mark or mark-all', async () => {
  const { model, calls } = fixture(); await model.activate({ ...scope, accountStatus: 'suspended' });
  await model.open(row()); await model.markAll();
  assert.equal(calls.filter(call => call.init?.method).length, 0); assert.equal(model.getSnapshot().canWrite, false);
  assert.ok(model.getSnapshot().detail.item);
});

test('mark-all unknown result retains the original UUID/body; retry never manufactures a new request', async () => {
  const sent = []; let attempts = 0;
  const { model } = fixture((path, init) => {
    if (path.endsWith('/read-all')) { sent.push(init.body); if (++attempts === 1) return new Promise(() => {}); }
  }, { timeoutMs: 20 });
  await model.activate(scope); await model.markAll();
  assert.ok(model.getSnapshot().pending); assert.equal(model.getSnapshot().unreadCount, null);
  await model.markAll(); assert.equal(sent.length, 1);
  await model.retry(); assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]); assert.ok(JSON.parse(sent[0]).requestId);
  assert.equal(model.getSnapshot().pending, null);
});

test('a timed-out auto-read can be dismissed without losing the original retry or reopening private detail', async () => {
  let attempts = 0;
  const { model } = fixture((path, init) => { if (path.endsWith('/read') && init?.method && ++attempts === 1) return new Promise(() => {}); }, { timeoutMs: 20 });
  await model.activate(scope); await model.open(row());
  assert.ok(model.getSnapshot().pending); assert.equal(model.getSnapshot().busy, false);
  model.closeDetail(); assert.equal(model.getSnapshot().detail.phase, 'idle'); assert.ok(model.getSnapshot().pending);
  await model.retry(); assert.equal(model.getSnapshot().pending, null); assert.equal(model.getSnapshot().detail.item, null);
});

test('confirmed read with failed refresh stays confirmed and retry does not repeat the write', async () => {
  let changed = false;
  const { model, calls } = fixture((path, init) => {
    if (init?.method) changed = true;
    else if (changed) throw httpError(503);
  });
  await model.activate(scope); await model.markAll();
  assert.equal(model.getSnapshot().pending, null); assert.ok(model.getSnapshot().success);
  assert.ok(model.getSnapshot().error); await model.retry();
  assert.equal(calls.filter(call => call.init?.method).length, 1);
});

test('opening a different already-read detail clears the previous operation confirmation', async () => {
  const { model } = fixture(); await model.activate(scope); await model.markAll(); assert.ok(model.getSnapshot().success);
  await model.open(row({ source: 'notification', id: 'old-notice', referenceId: 'old-notice', isRead: true }));
  assert.equal(model.getSnapshot().success, '');
});

test('filter and pagination are server-side and an old list cannot override a completed read', async () => {
  const delayed = deferred(); let slow = false;
  const { model, calls } = fixture((path, init) => {
    if (path.includes('after=')) return page(2, [row({ title: 'page two' })]);
    if (!init?.method && path.startsWith('/api/user/notifications')) return slow ? delayed.promise : page(2, [row()], 'next-token');
  });
  await model.activate(scope); await model.next(); assert.equal(model.getSnapshot().items[0].title, 'page two');
  await model.filter({ source: 'announcement', read: 'unread', history: true });
  assert.equal(model.getSnapshot().history.length, 0); assert.match(calls.at(-1).path, /source=announcement/);
  slow = true; const pending = model.refresh(); await new Promise(r => setImmediate(r));
  slow = false; await model.markAll(); delayed.resolve(page(99)); await pending;
  assert.equal(model.getSnapshot().unreadCount, 2);
});

test('newer detail wins and 401 removes all protected content', async () => {
  const delayed = deferred(); const denied = [];
  const { model } = fixture(path => path.includes('/old') ? delayed.promise : path.includes('/denied') ? Promise.reject(httpError(401)) : undefined,
    { onDenied: code => denied.push(code) });
  await model.activate(scope); const old = model.open(row({ referenceId: 'old' }));
  await new Promise(r => setImmediate(r)); await model.open(row({ referenceId: 'new', isRead: true }));
  delayed.resolve({ announcement: { ...row(), body: 'stale body' }, unreadCount: 99 }); await old;
  assert.notEqual(model.getSnapshot().detail.item.body, 'stale body');
  await model.open(row({ referenceId: 'denied' }));
  assert.deepEqual(denied, [401]); assert.equal(model.getSnapshot().detail.item, null); assert.deepEqual(model.getSnapshot().items, []);
});

test('global unread count fences both list-to-detail and detail-to-list out-of-order responses', async () => {
  const oldList = deferred(), oldDetail = deferred(); let slowList = false, slowDetail = false;
  const { model } = fixture(path => {
    if (path.startsWith('/api/user/announcements/')) return slowDetail ? oldDetail.promise : { announcement: { ...row(), id: row().referenceId, isRead: true, publishedAt: row().createdAt }, unreadCount: 3 };
    return slowList ? oldList.promise : page(1);
  });
  await model.activate({ ...scope, accountStatus: 'suspended' });
  slowList = true; const list = model.refresh(); await new Promise(r => setImmediate(r));
  await model.open(row()); assert.equal(model.getSnapshot().unreadCount, 3);
  oldList.resolve(page(7)); await list; assert.equal(model.getSnapshot().unreadCount, 3);
  slowList = false; slowDetail = true; const detail = model.open(row()); await new Promise(r => setImmediate(r));
  await model.refresh(); assert.equal(model.getSnapshot().unreadCount, 1);
  oldDetail.resolve({ announcement: { ...row(), id: row().referenceId, isRead: true, publishedAt: row().createdAt }, unreadCount: 3 });
  await detail; assert.equal(model.getSnapshot().unreadCount, 1);
});

test('503 detail marks unread unknown and a superseded list cannot restore its old numerical count', async () => {
  const oldList = deferred(); let delayed = false;
  const { model } = fixture(path => { if (path.startsWith('/api/user/announcements/')) throw httpError(503); return delayed ? oldList.promise : page(7); });
  await model.activate(scope); delayed = true; const list = model.refresh(); await new Promise(r => setImmediate(r));
  await model.open(row()); assert.equal(model.getSnapshot().unreadCount, null);
  oldList.resolve(page(7)); await list; assert.equal(model.getSnapshot().unreadCount, null);
});

test('visible polling deduplicates, pauses while hidden and cleans all listeners/timers', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const { model, calls } = fixture(); await model.activate(scope);
  const stop = watchNotifications(model, win, doc); const initial = calls.length;
  doc.visibilityState = 'hidden'; t.mock.timers.tick(30000); await Promise.resolve(); assert.equal(calls.length, initial);
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); await new Promise(r => setImmediate(r)); assert.equal(calls.length, initial + 1);
  stop(); t.mock.timers.tick(60000); win.dispatchEvent(new Event('focus')); await Promise.resolve(); assert.equal(calls.length, initial + 1);
});
