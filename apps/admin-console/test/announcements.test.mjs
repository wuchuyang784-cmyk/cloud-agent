import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AnnouncementSession, draftError } from '../src/announcements.ts';
import { AdminSession } from '../src/session.ts';

const me = { role: 'platform_admin', permissions: ['announcements:read', 'announcement-audit:read', 'announcements:manage', 'users:read'], user: { id: 'admin', email: 'admin@example.test' } };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const item = (overrides = {}) => ({ id: randomUUID(), title: '公告标题', body: '正文\n内容', severity: 'normal', pinned: false,
  status: 'draft', version: 1, createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z',
  expiryDays: 30, expiresAt: null, scheduledAt: null, publishedAt: null, ...overrides });

function fixture(override, options = {}) {
  let current = item(); const commands = [];
  const transport = async (path, init) => {
    if (override) { const value = await override(path, init); if (value) return value; }
    if (init?.method && init.method !== 'GET') {
      const input = JSON.parse(init.body); commands.push({ path, method: init.method, body: input });
      current = { ...current, ...input, version: path.endsWith('/publish') ? current.version + 1 : path.endsWith('/withdraw') ? current.version + 1 : input.expectedVersion ? input.expectedVersion + 1 : 1,
        status: path.endsWith('/publish') ? 'published' : path.endsWith('/withdraw') ? 'withdrawn' : 'draft' };
      return response({ announcement: current, requestId: input.requestId, replayed: false });
    }
    if (path.includes('/audit')) return response({ items: [], nextCursor: null });
    if (path.startsWith('/api/admin/announcements/' + current.id)) return response({ announcement: current });
    return response({ items: [current], nextCursor: null });
  };
  return { model: new AnnouncementSession(transport, options), commands, current: () => current };
}

test('announcement editor saves before confirmation, requires explicit publish and never edits published text', async () => {
  const { model, commands } = fixture(); await model.activate(me);
  model.newDraft(); model.updateDraft({ title: '新公告', body: '新正文' });
  model.confirm('publish'); assert.equal(model.getSnapshot().confirmation, null);
  await model.save(); assert.equal(commands.length, 1); assert.equal(commands[0].method, 'POST');
  assert.equal(model.getSnapshot().dirty, false);
  model.confirm('publish'); assert.equal(model.getSnapshot().confirmation, 'publish');
  await model.submit(); assert.equal(commands[1].body.expectedVersion, 1);
  assert.equal(model.getSnapshot().selected.status, 'published');
  model.updateDraft({ title: 'must not modify' });
  await model.save(); assert.equal(commands.length, 2);
  model.confirm('withdraw'); await model.submit('内容纠错');
  assert.equal(commands[2].body.reason, '内容纠错');
  assert.equal(model.getSnapshot().selected.status, 'withdrawn');
  model.newDraft(model.getSnapshot().selected);
  assert.equal(model.getSnapshot().selected, null);
  assert.equal(model.getSnapshot().draft.title, '新公告');
});

test('timeout preserves exact method/path/UUID/body, locks editing and retries original create', async () => {
  const sent = []; let attempts = 0;
  const { model } = fixture(async (path, init) => {
    if (init?.method === 'POST') { sent.push(JSON.parse(init.body)); if (++attempts === 1) return new Promise(() => {}); }
  }, { timeoutMs: 20 });
  await model.activate(me); model.newDraft(); model.updateDraft({ title: '原标题', body: 'body' });
  await model.save(); assert.ok(model.getSnapshot().pending);
  model.updateDraft({ title: 'changed' }); assert.equal(model.getSnapshot().draft.title, '原标题');
  await model.retry(); assert.deepEqual(sent[0], sent[1]);
  assert.equal(model.getSnapshot().pending, null); assert.ok(model.getSnapshot().success);
});

test('409 keeps local content but fences further writes until explicit reload', async () => {
  let mutations = 0;
  const { model, current } = fixture(async (path, init) => { if (init?.method === 'PATCH') { mutations++; return response({ error: { code: 'version_conflict' } }, 409); } });
  await model.activate(me); await model.open(current().id); model.updateDraft({ title: 'local revision' });
  await model.save(); assert.equal(model.getSnapshot().needsReload, true);
  assert.equal(model.getSnapshot().draft.title, 'local revision');
  await model.save(); assert.equal(mutations, 1); assert.equal(model.getSnapshot().pending, null);
  await model.open(current().id); assert.equal(model.getSnapshot().needsReload, false);
});

test('definitive rejected create preserves editable content and can be corrected with a new request', async () => {
  const sent = [];
  const { model } = fixture(async (path, init) => {
    if (init?.method === 'POST') { sent.push(JSON.parse(init.body)); if (sent.length === 1) return response({ error: { code: 'invalid_announcement_time' } }, 422); }
  });
  await model.activate(me); model.newDraft(); model.updateDraft({ title: 'preserved', body: 'body' });
  await model.save(); assert.equal(model.getSnapshot().pending, null); assert.equal(model.getSnapshot().needsReload, false);
  assert.equal(model.getSnapshot().draft.title, 'preserved');
  model.updateDraft({ title: 'corrected' }); await model.save();
  assert.equal(sent[1].title, 'corrected'); assert.notEqual(sent[0].requestId, sent[1].requestId);
  assert.ok(model.getSnapshot().success);
});

test('detail rejection leaves visible recoverable error and dirty draft cannot be overwritten by copying stored content', async () => {
  const { model, current } = fixture(async path => path.endsWith('/missing') ? response({}, 503) : undefined);
  await model.activate(me); await model.open('missing');
  assert.ok(model.getSnapshot().error); assert.equal(model.getSnapshot().detailLoading, false);
  await model.open(current().id); assert.equal(model.getSnapshot().error, '');
  model.updateDraft({ title: 'unsaved local' }); model.newDraft(current());
  assert.equal(model.getSnapshot().draft.title, 'unsaved local'); assert.equal(model.getSnapshot().selected.id, current().id);
});

test('unrelated draft edits preserve explicit expiry seconds and milliseconds', async () => {
  const original = item({ expiryDays: null, expiresAt: '2099-01-02T03:04:59.987Z' });
  const { model, commands } = fixture(async (path, init) => !init?.method && path === '/api/admin/announcements/' + original.id ? response({ announcement: original }) : undefined);
  await model.activate(me); await model.open(original.id); model.updateDraft({ title: 'another title' }); await model.save();
  assert.equal(commands[0].body.expiresAt, original.expiresAt);
});

test('confirmed mutation with failed audit reload reports success separately, without resending', async () => {
  let changed = false;
  const { model, commands } = fixture(async (path, init) => {
    if (init?.method === 'POST') changed = true;
    if (changed && path.includes('/audit')) return response({}, 503);
  });
  await model.activate(me); model.newDraft(); model.updateDraft({ title: 'test', body: 'body' });
  await model.save(); assert.equal(commands.length, 1);
  assert.equal(model.getSnapshot().pending, null);
  assert.ok(model.getSnapshot().success); assert.ok(model.getSnapshot().audit.error);
});

test('reset and denied requests clear protected content and ignore transports that disregard abort', async () => {
  const pending = deferred(); const denied = [];
  const { model, current } = fixture(async path => path.includes('/audit') ? response({}, 403) : undefined, { onDenied: status => denied.push(status) });
  await model.activate(me); model.newDraft(); model.updateDraft({ title: 'private draft', body: 'private body' });
  const id = current().id;
  const stale = new AnnouncementSession(async () => pending.promise);
  const load = stale.activate(me); stale.reset(); pending.resolve(response({ items: [item()], nextCursor: null })); await load;
  assert.deepEqual(stale.getSnapshot().items, []);
  await model.open(id);
  assert.deepEqual(denied, [403]); assert.equal(model.getSnapshot().draft, null); assert.deepEqual(model.getSnapshot().items, []);
});

test('new detail wins over stale detail and role downgrade clears editable draft', async () => {
  const delayed = deferred(), old = item(), fresh = item();
  const { model } = fixture(async path => path === '/api/admin/announcements/' + old.id ? delayed.promise : path === '/api/admin/announcements/' + fresh.id ? response({ announcement: fresh }) : undefined);
  await model.activate(me); const opening = model.open(old.id); await new Promise(r => setImmediate(r));
  await model.open(fresh.id); delayed.resolve(response({ announcement: old })); await opening;
  assert.equal(model.getSnapshot().selected.id, fresh.id);
  model.updateDraft({ title: 'unsaved' });
  await model.activate({ ...me, role: 'platform_viewer', permissions: ['announcements:read', 'announcement-audit:read'] });
  assert.equal(model.getSnapshot().draft, null); assert.equal(model.getSnapshot().canManage, false);
});

test('identity refresh preserves unsaved editor; readonly users cannot manufacture a create or retry', async () => {
  const { model, commands } = fixture();
  await model.activate(me); model.newDraft(); model.updateDraft({ title: 'unsaved', body: 'body' }); await model.activate(me);
  assert.equal(model.getSnapshot().draft.title, 'unsaved');
  await model.activate({ ...me, role: 'platform_operator', permissions: ['announcements:read', 'announcement-audit:read'] });
  model.newDraft(); await model.save(); await model.retry(); assert.equal(commands.length, 0);
});

test('front validation uses Unicode codepoints, rejects empty/control text and requires valid Shanghai expiry', () => {
  const valid = { title: '😀'.repeat(120), body: 'a\nb', severity: 'normal', pinned: false, expiryMode: 'default', expiresLocal: '' };
  assert.equal(draftError(valid), '');
  for (const patch of [{ title: ' ' }, { body: ' ' }, { title: 'a\n' }, { body: 'x\u0000' }, { expiryMode: 'at', expiresLocal: 'bad' }, { expiryMode: 'at', expiresLocal: '2026-02-30T10:00' }]) assert.ok(draftError({ ...valid, ...patch }));
});

test('saving default expiry sends an explicit reset policy rather than silently retaining indefinite expiry', async () => {
  const { model, commands } = fixture(); await model.activate(me); model.newDraft(); model.updateDraft({ title: 'policy', body: 'body' });
  await model.save(); assert.equal(commands[0].body.expiryDays, 30);
});

test('D requires saved draft and valid Shanghai schedule then preserves exact schedule UUID on unknown result', async () => {
  let fail = true; const sent = [];
  const { model } = fixture(async (path, init) => {
    if (path.endsWith('/publish') && init?.method === 'POST') {
      sent.push({ path, body: JSON.parse(init.body) });
      if (fail) return response({}, 503);
      return response({ announcement: item({ status: 'scheduled', version: 2, scheduledAt: sent.at(-1).body.scheduledAt }) });
    }
  });
  await model.activate(me); model.newDraft(); model.updateDraft({ title: '定时公告', body: 'body' });
  model.confirm('schedule'); assert.equal(model.getSnapshot().confirmation, null);
  await model.save(); model.confirm('schedule'); assert.equal(model.getSnapshot().confirmation, 'schedule');
  for (const local of ['', 'invalid', '2099-02-30T10:00', '2020-01-01T10:00']) {
    await model.schedule(local); assert.equal(sent.length, 0); assert.ok(model.getSnapshot().error);
  }
  await model.schedule('2099-01-01T10:30');
  assert.equal(sent[0].body.scheduledAt, '2099-01-01T02:30:00.000Z'); assert.equal(sent[0].body.mode, 'schedule');
  assert.equal(sent[0].body.expectedVersion, 1); assert.ok(model.getSnapshot().pending);
  fail = false; await model.retry(); assert.deepEqual(sent[0], sent[1]);
  assert.equal(model.getSnapshot().selected.status, 'scheduled'); assert.match(model.getSnapshot().success, /定时/);
});

test('D cannot schedule after explicit expiry and cancel uses version+idempotent exact request with explicit confirmation', async () => {
  const a = item({ expiryDays: null, expiresAt: '2099-01-01T01:00:00Z' }); let current = a; const sent = [];
  let fail = true;
  const { model } = fixture(async (path, init) => {
    if (path === '/api/admin/announcements/' + a.id && !init?.method) return response({ announcement: current });
    if (path.endsWith('/cancel-schedule')) {
      sent.push(JSON.parse(init.body)); if (fail) return response({}, 503);
      return response({ announcement: { ...a, version: 3, status: 'draft', publishBlocked: false } });
    }
  });
  await model.activate(me); await model.open(a.id); model.confirm('schedule'); await model.schedule('2099-01-01T10:00');
  assert.equal(model.getSnapshot().pending, null); assert.match(model.getSnapshot().error, /截止/);
  current = { ...a, status: 'scheduled', version: 2, publishBlocked: true }; await model.open(a.id);
  await model.submit(); assert.equal(sent.length, 0);
  model.confirm('cancel-schedule'); await model.submit(); assert.equal(sent.length, 1); assert.equal(sent[0].expectedVersion, 2);
  fail = false; await model.retry(); assert.deepEqual(sent[0], sent[1]);
  assert.equal(model.getSnapshot().selected.status, 'draft'); assert.equal(model.getSnapshot().selected.publishBlocked, false);
});

test('AdminSession invalidates announcement state on logout, navigation and failed background authorization', async () => {
  let reject = false;
  const session = new AdminSession(async path => path === '/api/admin/me' ? response(me, reject ? 403 : 200)
    : path.includes('sign-out') ? response({}) : response({ items: [], nextCursor: null }));
  await session.load({ view: 'announcements' });
  session.announcements.newDraft(); session.announcements.updateDraft({ title: 'private', body: 'body' });
  reject = true; await session.refresh({ view: 'announcements' });
  assert.equal(session.getSnapshot().phase, 'denied'); assert.equal(session.announcements.getSnapshot().draft, null);
  reject = false; await session.load({ view: 'announcements' }); session.announcements.newDraft();
  await session.load({ view: 'users' }); assert.equal(session.announcements.getSnapshot().draft, null);
  await session.load({ view: 'announcements' }); session.announcements.newDraft(); await session.signOut();
  assert.equal(session.announcements.getSnapshot().draft, null);
});
