import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createApp } from '../src/app.mjs';
import { MemoryStore } from '../src/store.mjs';
import { routeLabel } from '../src/observability/labels.mjs';
import { handleAnnouncementAdmin } from '../src/announcements/admin-routes.mjs';

async function fixture(t) {
  const store = new MemoryStore({ seed: { users: ['admin', 'second', 'viewer', 'operator', 'user'].map(id => ({ id, email: id + '@example.test', organizationId: 'org-' + id, role: 'org_admin' })) } });
  store.platformRoles = new Map(['admin', 'second', 'viewer', 'operator'].map(id => [id, { role: 'platform_' + (id === 'second' ? 'admin' : id), revokedAt: null }]));
  const env = { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: 'http://localhost:8080' };
  const auth = { provider: 'better-auth', async resolve(req) { const user = store.findUser(req.headers['x-test-user']); return user && { userId: user.id, organizationId: user.organizationId, role: user.role }; } };
  const app = createApp({ store, auth, env });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => app.close(r)));
  const request = (path, { method = 'GET', body, actor = 'admin', headers = {} } = {}) => fetch('http://127.0.0.1:' + app.address().port + path,
    { method, headers: { ...(actor ? { 'x-test-user': actor } : {}), origin: env.BETTER_AUTH_URL, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const create = async (input = {}, options = {}) => request('/api/admin/announcements', { method: 'POST', body: { title: '维护公告', body: '通知正文\n后续说明', requestId: randomUUID(), ...input }, ...options });
  return { store, request, create };
}

test('announcement API requires real platform access and advertises explicit read/manage permissions', async t => {
  const { request, create } = await fixture(t);
  assert.equal((await request('/api/admin/announcements', { actor: null })).status, 401);
  assert.equal((await request('/api/admin/announcements', { actor: 'user' })).status, 403);
  for (const actor of ['admin', 'viewer', 'operator']) {
    const me = await (await request('/api/admin/me', { actor })).json();
    assert.ok(me.permissions.includes('announcements:read'));
    assert.ok(me.permissions.includes('announcement-audit:read'));
    assert.equal(me.permissions.includes('announcements:manage'), actor === 'admin');
    assert.equal((await request('/api/admin/announcements', { actor })).status, 200);
    if (actor !== 'admin') assert.equal((await create({}, { actor })).status, 403);
  }
});

test('announcement API saves/previews/publishes/withdraws and audits once; list excludes body', async t => {
  const { request, create } = await fixture(t);
  const requestId = randomUUID();
  const created = await create({ requestId });
  assert.equal(created.status, 201);
  const a = (await created.json()).announcement;
  assert.equal(created.headers.get('location'), '/api/admin/announcements/' + a.id);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal((await (await create({ requestId })).json()).announcement.id, a.id);
  const edit = await request('/api/admin/announcements/' + a.id, { method: 'PATCH', body: { expectedVersion: 1, requestId: randomUUID(), title: '已修改', body: '修订正文' } });
  assert.equal(edit.status, 200);
  const published = await request('/api/admin/announcements/' + a.id + '/publish', { method: 'POST', body: { expectedVersion: 2, requestId: randomUUID() } });
  assert.equal(published.status, 200);
  assert.equal((await published.json()).announcement.status, 'published');
  const list = await (await request('/api/admin/announcements?status=published&limit=1')).json();
  assert.equal(list.items.length, 1);
  assert.equal('body' in list.items[0], false);
  assert.equal((await (await request('/api/admin/announcements/' + a.id)).json()).announcement.body, '修订正文');
  assert.equal((await request('/api/admin/announcements/' + a.id, { method: 'PATCH', body: { expectedVersion: 3, requestId: randomUUID(), title: 'x', body: 'x' } })).status, 409);
  assert.equal((await request('/api/admin/announcements/' + a.id + '/withdraw', { method: 'POST', body: { expectedVersion: 3, requestId: randomUUID(), reason: '纠正内容' } })).status, 200);
  const audit = await (await request('/api/admin/announcements/' + a.id + '/audit?limit=2')).json();
  assert.deepEqual(audit.items.map(x => x.action), ['withdrawn', 'published']);
  assert.ok(audit.nextCursor);
  assert.equal((await (await request('/api/admin/announcements/' + a.id + '/audit?after=' + audit.nextCursor)).json()).items.length, 2);
});

test('announcement API validates query/path/method/origin/body and accepts explicit D scheduling', async t => {
  const { request, create } = await fixture(t);
  const a = (await (await create()).json()).announcement;
  for (const query of ['actor=admin', 'limit=101', 'limit=1&limit=2', 'audit=true', 'status=bad', 'q=%00', 'after=bad']) assert.equal((await request('/api/admin/announcements?' + query)).status, 422, query);
  for (const input of [{ actorUserId: 'second' }, { action: 'publish' }, { id: a.id }, { requestId: 'bad' }, { title: ' ' }]) assert.equal((await create(input)).status, 422);
  assert.equal((await create({}, { headers: { origin: 'https://other.test' } })).status, 403);
  assert.equal((await create({}, { headers: { origin: '' } })).status, 403);
  assert.equal((await create({}, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/admin/announcements', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await create({ body: 'a'.repeat(140000) })).status, 413);
  const method = await request('/api/admin/announcements/' + a.id, { method: 'DELETE' });
  assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'GET, PATCH');
  assert.equal((await request('/api/admin/announcements/not-a-uuid')).status, 404);
  assert.equal((await request('/api/admin/announcements/' + randomUUID())).status, 404);
  assert.equal((await request('/api/admin/announcements/' + a.id + '/publish', { method: 'POST', body: { mode: 'schedule', scheduledAt: '2099-01-01T00:00:00Z', expectedVersion: 1, requestId: randomUUID() } })).status, 200);
  assert.equal((await request('/api/user/announcements', { actor: 'user' })).status, 200);
});

test('D scheduled intent stays private, cancels idempotently and requires a fresh version to reconfirm', async t => {
  const { request, create } = await fixture(t); const a = (await (await create()).json()).announcement;
  const path = '/api/admin/announcements/' + a.id;
  const command = { mode: 'schedule', scheduledAt: '2099-01-01T00:00:00Z', expectedVersion: 1, requestId: randomUUID() };
  const result = await request(path + '/publish', { method: 'POST', body: command });
  assert.equal(result.status, 200); assert.equal((await result.json()).announcement.status, 'scheduled');
  assert.equal((await request('/api/user/announcements/' + a.id, { actor: 'user' })).status, 404);
  assert.equal((await request(path + '/publish', { method: 'POST', body: { ...command, mode: 'now' } })).status, 422);
  assert.equal((await request(path + '/cancel-schedule', { method: 'POST', actor: 'viewer', body: { expectedVersion: 2, requestId: randomUUID() } })).status, 403);
  const cancel = { expectedVersion: 2, requestId: randomUUID() };
  for (let n = 0; n < 2; n++) {
    const response = await request(path + '/cancel-schedule', { method: 'POST', body: cancel });
    assert.equal(response.status, 200); assert.equal((await response.json()).announcement.status, 'draft');
  }
  assert.equal((await request(path + '/publish', { method: 'POST', body: { ...command, requestId: randomUUID() } })).status, 409);
  assert.equal((await request(path + '/publish', { method: 'POST', body: { ...command, expectedVersion: 3, requestId: randomUUID() } })).status, 200);
  for (const patch of [{ mode: 'other' }, { mode: 'immediate', scheduledAt: command.scheduledAt }, { scheduledAt: command.scheduledAt }]) {
    assert.equal((await request(path + '/publish', { method: 'POST', body: { expectedVersion: 4, requestId: randomUUID(), ...patch } })).status, 422);
  }
});

test('announcement API fences conflicts, rechecks governance/role and has bounded per-instance write rate', async t => {
  const { store, request, create } = await fixture(t);
  const a = (await (await create()).json()).announcement;
  const body = { expectedVersion: 1, requestId: randomUUID() };
  const results = await Promise.all([request('/api/admin/announcements/' + a.id + '/publish', { method: 'POST', body }), request('/api/admin/announcements/' + a.id + '/publish', { method: 'POST', body })]);
  assert.ok(results.every(r => r.status === 200));
  store.platformRoles.get('admin').revokedAt = new Date().toISOString();
  assert.equal((await request('/api/admin/announcements/' + a.id)).status, 403);
  store.platformRoles.get('admin').revokedAt = null;
  store.accountGovernance = new Map([['admin', { status: 'suspended', version: 1 }]]);
  assert.equal((await create()).status, 403);
  store.accountGovernance.clear();
  let limited;
  for (let n = 0; n < 32; n++) { const result = await create(); if (result.status === 429) { limited = result; break; } }
  assert.ok(limited); assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('announcement metric labels never contain announcement IDs or queries', () => {
  const id = randomUUID();
  for (const tail of ['', '/publish', '/cancel-schedule', '/withdraw', '/audit']) assert.equal(routeLabel('/api/admin/announcements/' + id + tail + '?q=private'), '/api/admin/announcements/:announcementId' + tail);
  assert.equal(routeLabel('/api/admin/announcements?q=private'), '/api/admin/announcements');
});

function uploadFixture() {
  const store = new MemoryStore({ seed: { users: [{ id: 'admin', organizationId: 'org', role: 'org_admin' }] } });
  store.platformRoles = new Map([['admin', { role: 'platform_admin', revokedAt: null }]]);
  return () => {
    const request = Object.assign(new PassThrough(), { method: 'POST', headers: { origin: 'http://localhost:8080', 'content-type': 'application/json' } });
    const headers = {}, result = {};
    const completed = handleAnnouncementAdmin({ request, response: { setHeader: (key, value) => { headers[key] = value; } },
      url: new URL('http://localhost:8080/api/admin/announcements'), actor: 'admin', access: { role: 'platform_admin', permissions: ['announcements:manage'] },
      store, env: { BETTER_AUTH_URL: 'http://localhost:8080' }, fail: (status, error) => Object.assign(result, { status, error }),
      sendJson: (_, status, body) => Object.assign(result, { status, body }) });
    return { request, result, completed, headers };
  };
}
const uploadBody = () => JSON.stringify({ requestId: randomUUID(), title: '中文😀', body: '多字节正文' });

test('eight incomplete uploads bound concurrency; abort releases a slot and split UTF-8 bytes decode intact', async () => {
  const upload = uploadFixture(), active = Array.from({ length: 8 }, () => upload());
  const denied = upload(); denied.request.end(); await denied.completed;
  assert.equal(denied.result.status, 429); assert.equal(denied.headers['retry-after'], '1');
  active[0].request.emit('aborted'); await active[0].completed; assert.equal(active[0].result.status, 400);
  const fresh = upload(), body = Buffer.from(uploadBody()), split = body.indexOf(Buffer.from('中')) + 1;
  fresh.request.write(body.subarray(0, split)); fresh.request.end(body.subarray(split)); await fresh.completed;
  assert.equal(fresh.result.status, 201); assert.equal(fresh.result.body.announcement.title, '中文😀');
  for (const pending of active.slice(1)) pending.request.end(uploadBody());
  await Promise.all(active.map(pending => pending.completed));
  assert.ok(active.slice(1).every(pending => pending.result.status === 201));
});

test('body deadline is total rather than idle and every timed-out upload releases its slot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const upload = uploadFixture(), active = Array.from({ length: 8 }, () => upload());
  for (const pending of active) pending.request.write('{');
  t.mock.timers.tick(14999);
  for (const pending of active) { assert.equal(pending.result.status, undefined); pending.request.write(' '); }
  t.mock.timers.tick(1); await Promise.all(active.map(pending => pending.completed));
  assert.ok(active.every(pending => pending.result.status === 408));
  const fresh = upload(); fresh.request.end(uploadBody()); await fresh.completed;
  assert.equal(fresh.result.status, 201);
});
