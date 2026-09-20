import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.mjs';

async function withApp(run) {
  const app = createApp({
    env: { NODE_ENV: 'test', BAIRUI_PLATFORM_MODE: 'legacy' },
    seed: {
      users: [
        { id: 'user-a', email: 'a@example.test', password: 'password-a', organizationId: 'org-a', role: 'user' },
        { id: 'user-b', email: 'b@example.test', password: 'password-b', organizationId: 'org-b', role: 'user' },
      ],
      resources: [
        { id: 'resource-a', ownerUserId: 'user-a', organizationId: 'org-a', kind: 'knowledge_base', name: '客服知识库', description: 'A 用户资源' },
        { id: 'resource-b', ownerUserId: 'user-b', organizationId: 'org-b', kind: 'skill', name: '数据查询 Skill', description: 'B 用户资源' },
      ],
    },
  });
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

async function login(baseUrl, email, password) {
  const result = await json(`${baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200);
  return result.response.headers.get('set-cookie');
}

test('resource library lists only resources owned by the current user', async () => {
  await withApp(async (baseUrl) => {
    const cookie = await login(baseUrl, 'a@example.test', 'password-a');
    const listed = await json(`${baseUrl}/api/user/resources`, { headers: { cookie } });
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.resources.map((resource) => resource.id), ['resource-a']);

    const other = await json(`${baseUrl}/api/user/resources/resource-b`, { headers: { cookie } });
    assert.equal(other.response.status, 404);
    assert.equal(other.body.error.code, 'resource_not_found');
  });
});

test('resource library creates, updates, filters, and deletes client resources', async () => {
  await withApp(async (baseUrl) => {
    const cookie = await login(baseUrl, 'a@example.test', 'password-a');
    const created = await json(`${baseUrl}/api/user/resources`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'skill', name: '订单查询', description: '查询订单状态', config: { version: 1 } }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.resource.kind, 'skill');
    assert.deepEqual(created.body.resource.config, { version: 1 });

    const filtered = await json(`${baseUrl}/api/user/resources?kind=skill`, { headers: { cookie } });
    assert.equal(filtered.response.status, 200);
    assert.deepEqual(filtered.body.resources.map((resource) => resource.name), ['订单查询']);

    const updated = await json(`${baseUrl}/api/user/resources/${created.body.resource.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '订单查询 v2', status: 'archived' }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.resource.name, '订单查询 v2');
    assert.equal(updated.body.resource.status, 'archived');

    const removed = await json(`${baseUrl}/api/user/resources/${created.body.resource.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.equal(removed.response.status, 204);
    const missing = await json(`${baseUrl}/api/user/resources/${created.body.resource.id}`, { headers: { cookie } });
    assert.equal(missing.response.status, 404);
  });
});

test('resource library creates and filters tool and plugin kinds for agent integration', async () => {
  await withApp(async (baseUrl) => {
    const cookie = await login(baseUrl, 'a@example.test', 'password-a');
    for (const kind of ['tool', 'plugin']) {
      const created = await json(`${baseUrl}/api/user/resources`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ kind, name: kind + '-demo', description: kind + ' 演示资源' }),
      });
      assert.equal(created.response.status, 201);
      assert.equal(created.body.resource.kind, kind);
    }
    const tools = await json(`${baseUrl}/api/user/resources?kind=tool`, { headers: { cookie } });
    assert.equal(tools.response.status, 200);
    assert.deepEqual(tools.body.resources.map((resource) => resource.kind), ['tool']);
  });
});

test('resource library persists and updates resource content body for later retrieval', async () => {
  await withApp(async (baseUrl) => {
    const cookie = await login(baseUrl, 'a@example.test', 'password-a');
    const created = await json(`${baseUrl}/api/user/resources`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'knowledge_base', name: '质检知识库', content: '第一段正文：质检标准\n第二段正文：投诉处理' }),
    });
    assert.equal(created.response.status, 201);

    const detail = await json(`${baseUrl}/api/user/resources/${created.body.resource.id}`, { headers: { cookie } });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.contentItems.length, 1);
    assert.equal(detail.body.contentItems[0].kind, 'text');
    assert.equal(detail.body.contentItems[0].content, '第一段正文：质检标准\n第二段正文：投诉处理');

    const updated = await json(`${baseUrl}/api/user/resources/${created.body.resource.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: '更新后的质检知识库正文' }),
    });
    assert.equal(updated.response.status, 200);
    const after = await json(`${baseUrl}/api/user/resources/${created.body.resource.id}`, { headers: { cookie } });
    assert.deepEqual(after.body.contentItems.map((item) => item.content), ['更新后的质检知识库正文']);

    const cleared = await json(`${baseUrl}/api/user/resources/${created.body.resource.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: null }),
    });
    assert.equal(cleared.response.status, 200);
    const empty = await json(`${baseUrl}/api/user/resources/${created.body.resource.id}`, { headers: { cookie } });
    assert.deepEqual(empty.body.contentItems, []);
  });
});

test('resource library rejects unsupported resource kinds and blank names', async () => {
  await withApp(async (baseUrl) => {
    const cookie = await login(baseUrl, 'a@example.test', 'password-a');
    for (const input of [{ kind: 'mcp', name: '不支持' }, { kind: 'skill', name: ' ' }, { kind: 'skill', name: '非法内容', content: 123 }]) {
      const result = await json(`${baseUrl}/api/user/resources`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      assert.equal(result.response.status, 422);
      assert.equal(result.body.error.code, 'validation_error');
    }
  });
});
