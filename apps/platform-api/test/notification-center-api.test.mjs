import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';
import { changeAnnouncement } from '../src/announcements/store.mjs';
import { routeLabel } from '../src/observability/labels.mjs';
import { PassThrough } from 'node:stream';
import { handleNotificationCenter } from '../src/announcements/user-routes.mjs';

function uploadFixture() {
  const store = new MemoryStore({ seed: { users: [{ id: 'user', organizationId: 'org-user', role: 'org_admin' }] } });
  return (method = 'POST') => {
    const request = Object.assign(new PassThrough(), { method, headers: { origin: 'http://localhost:8080', 'content-type': 'application/json' } });
    const headers = {}, result = {};
    const completed = handleNotificationCenter({ request, response: { setHeader: (key, value) => { headers[key] = value; } },
      url: new URL('http://localhost:8080/api/user/notifications' + (method === 'GET' ? '' : '/read-all')),
      scope: { userId: 'user', organizationId: 'org-user' }, store, env: { BETTER_AUTH_URL: 'http://localhost:8080' }, strictOrigin: true,
      sendError: (_, status, code) => Object.assign(result, { status, code }), sendJson: (_, status, body) => Object.assign(result, { status, body }) });
    return { request, headers, result, completed };
  };
}

test('notification upload concurrency is bounded and abort releases admission', async () => {
  const upload = uploadFixture(), active = Array.from({ length: 16 }, () => upload());
  const denied = upload(); denied.request.end(); await denied.completed;
  assert.equal(denied.result.status, 429); assert.equal(denied.headers['retry-after'], '1');
  active[0].request.emit('aborted'); await active[0].completed; assert.equal(active[0].result.status, 400);
  const next = upload(); next.request.end(JSON.stringify({ requestId: randomUUID() })); await next.completed; assert.equal(next.result.status, 200);
  for (const pending of active.slice(1)) pending.request.end(JSON.stringify({ requestId: randomUUID() }));
  await Promise.all(active.map(x => x.completed)); assert.ok(active.slice(1).every(x => x.result.status === 200));
});

test('notification upload deadline is total and rate budgets apply to reads and writes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const upload = uploadFixture(), pending = upload(); pending.request.write('{');
  t.mock.timers.tick(9999); assert.equal(pending.result.status, undefined); pending.request.write(' ');
  t.mock.timers.tick(1); await pending.completed; assert.equal(pending.result.status, 408);
  const next = upload(); next.request.end(JSON.stringify({ requestId: randomUUID() })); await next.completed; assert.equal(next.result.status, 200);
  const write = uploadFixture();
  for (let i = 0; i < 120; i++) { const current = write(); current.request.end(JSON.stringify({ requestId: randomUUID() })); await current.completed; assert.equal(current.result.status, 200); }
  const denied = write(); denied.request.end(); await denied.completed; assert.equal(denied.result.status, 429);
  const read = uploadFixture();
  for (let i = 0; i < 240; i++) { const current = read('GET'); current.request.end(); await current.completed; assert.equal(current.result.status, 200); }
  const readDenied = read('GET'); readDenied.request.end(); await readDenied.completed; assert.equal(readDenied.result.status, 429);
});

test('personal notification HTTP contract: auth, strict input, global unread and replay', async t => {
  const store = new MemoryStore({ seed: { users: ['admin', 'user', 'other'].map(id => ({ id, email: id + '@example.test', organizationId: 'org-' + id, role: 'org_admin' })) } });
  store.platformRoles = new Map([['admin', { role: 'platform_admin' }]]);
  const auth = { provider: 'better-auth', async resolve(req) { const u = store.findUser(req.headers['x-test-user']); return u && { userId: u.id, organizationId: u.organizationId, role: u.role }; } };
  const env = { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: 'http://localhost:8080' };
  const app = createApp({ store, auth, env }); await new Promise(r => app.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => app.close(r)));
  const request = (path, { method = 'GET', body, actor = 'user', headers = {} } = {}) => fetch('http://127.0.0.1:' + app.address().port + path,
    { method, headers: { ...(actor ? { 'x-test-user': actor } : {}), origin: env.BETTER_AUTH_URL, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const draft = (await changeAnnouncement(store, 'admin', { action: 'create', title: '全文公告', body: '😀'.repeat(500), requestId: randomUUID() })).announcement;
  await changeAnnouncement(store, 'admin', { action: 'publish', id: draft.id, expectedVersion: 1, requestId: randomUUID() });
  const own = store.addNotification({ userId: 'user', organizationId: 'org-user' }, { title: '本人通知' });
  const foreign = store.addNotification({ userId: 'other', organizationId: 'org-other' }, { title: '他人通知' });
  await t.test('lists and details expose fixed personal projection and common global count', async () => {
    const list = await request('/api/user/notifications?source=announcement'); assert.equal(list.status, 200);
    const data = await list.json(); assert.equal(data.unreadCount, 2); assert.equal(data.notifications.length, 1); assert.equal([...data.notifications[0].body].length, 240);
    const notices = await request('/api/user/announcements'); assert.equal(notices.status, 200); assert.equal((await notices.json()).unreadCount, 2);
    const detail = await request('/api/user/announcements/' + draft.id); assert.equal(detail.status, 200);
    const full = await detail.json(); assert.equal(full.unreadCount, 2); assert.equal([...full.announcement.body].length, 500); assert.equal('createdBy' in full.announcement, false);
    assert.equal(detail.headers.get('cache-control'), 'no-store');
  });
  await t.test('query/path/method/body/origin and ownership reject without mutations', async () => {
    const anonymous = await request('/api/user/notifications', { actor: null });
    assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    for (const q of ['userId=other', 'organizationId=org-other', 'read=bad', 'source=nope', 'limit=01', 'history=1', 'limit=1&limit=2', 'after=bad']) assert.equal((await request('/api/user/notifications?' + q)).status, 422, q);
    assert.equal((await request('/api/user/announcements/' + draft.id + '?source=all')).status, 422);
    assert.equal((await request('/api/user/announcements/not-id')).status, 404);
    assert.equal((await request('/api/user/notifications', { method: 'DELETE' })).status, 405);
    assert.equal((await request('/api/user/notifications/' + foreign.id, { method: 'PATCH', body: { read: true } })).status, 404);
    assert.equal((await request('/api/user/notifications/announcement:' + draft.id, { method: 'PATCH', body: { read: true } })).status, 404);
    for (const body of [null, [], { read: false }, { userId: 'other' }]) assert.equal((await request('/api/user/notifications/' + own.id, { method: 'PATCH', body })).status, 422);
    assert.equal((await request('/api/user/notifications/' + own.id, { method: 'PATCH', body: '{' })).status, 400);
    assert.equal((await request('/api/user/notifications/read-all', { method: 'POST', body: {}, headers: { origin: 'http://evil.test' } })).status, 403);
    assert.equal((await request('/api/user/notifications/read-all', { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await request('/api/user/notifications/read-all', { method: 'POST', body: {} })).status, 422);
    assert.equal((await request('/api/user/notifications/read-all', { method: 'POST', body: { requestId: randomUUID(), padding: 'x'.repeat(4096) } })).status, 413);
  });
  await t.test('single marks are repeatable, preserve other reader and global counts', async () => {
    const first = await request('/api/user/announcements/' + draft.id + '/read', { method: 'POST', body: {} }); assert.equal(first.status, 200); assert.equal((await first.json()).unreadCount, 1);
    assert.equal((await (await request('/api/user/announcements/' + draft.id + '/read', { method: 'POST' })).json()).unreadCount, 1);
    assert.equal((await (await request('/api/user/announcements/' + draft.id, { actor: 'other' })).json()).announcement.isRead, false);
    const normal = await request('/api/user/notifications/' + own.id, { method: 'PATCH', body: { read: true } }); assert.equal(normal.status, 200); assert.equal((await normal.json()).unreadCount, 0);
    assert.equal((await (await request('/api/user/notifications/' + own.id, { method: 'PATCH' })).json()).updated, 0);
  });
  await t.test('all-read request replay leaves new notifications unread; legacy empty request still works', async () => {
    const requestId = randomUUID(), path = '/api/user/notifications/read-all';
    assert.equal((await (await request(path, { method: 'POST', body: { requestId } })).json()).replayed, false);
    store.addNotification({ userId: 'user', organizationId: 'org-user' }, { title: '后来' });
    const replay = await (await request(path, { method: 'POST', body: { requestId } })).json(); assert.equal(replay.replayed, true); assert.equal(replay.unreadCount, 1);
    assert.equal((await request(path, { method: 'POST' })).status, 200);
  });
  await t.test('new announcement routes use fixed metric labels', () => {
    assert.equal(routeLabel('/api/user/announcements'), '/api/user/announcements');
    assert.equal(routeLabel('/api/user/announcements/' + draft.id), '/api/user/announcements/:announcementId');
    assert.equal(routeLabel('/api/user/announcements/' + draft.id + '/read'), '/api/user/announcements/:announcementId/read');
  });
  await t.test('expired announcements remain in history without reappearing as unread reminders', async () => {
    Object.assign(store.announcements.get(draft.id), { publishedAt: new Date(Date.now() - 2000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
    for (const path of ['/api/user/notifications?source=announcement&history=true&read=unread', '/api/user/announcements?history=true&read=unread']) {
      const response = await request(path, { actor: 'other' }); assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal((data.notifications ?? data.items).some(x => x.referenceId === draft.id), false, path);
    }
    const all = await (await request('/api/user/announcements?history=true', { actor: 'other' })).json();
    assert.equal(all.items.find(x => x.referenceId === draft.id).status, 'expired');
    const read = await (await request('/api/user/announcements?history=true&read=read')).json();
    assert.equal(read.items.find(x => x.referenceId === draft.id).status, 'expired');
  });
});
