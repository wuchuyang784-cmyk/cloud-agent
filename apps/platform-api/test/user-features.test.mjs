import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.mjs';

async function withApp(run) {
  const app = createApp({
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

async function json(baseUrl, path, options = {}) {
  const response = await fetch(baseUrl + path, { ...options, headers: { accept: 'application/json', ...options.headers } });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

async function login(baseUrl, email, password) {
  const result = await json(baseUrl, '/api/auth/dev-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200);
  return result.response.headers.get('set-cookie');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('favorites are scoped per user and support create, list, and delete', async () => {
  await withApp(async (baseUrl) => {
    const cookieA = await login(baseUrl, 'a@example.test', 'password-a');
    const cookieB = await login(baseUrl, 'b@example.test', 'password-b');

    const missing = await json(baseUrl, '/api/user/favorites', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ targetType: 'resource', targetId: 'resource-b' }),
    });
    assert.equal(missing.response.status, 404);

    const created = await json(baseUrl, '/api/user/favorites', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ targetType: 'resource', targetId: 'resource-a' }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.favorite.name, '客服知识库');

    const duplicate = await json(baseUrl, '/api/user/favorites', {
      method: 'POST',
      headers: { cookie: cookieA, 'content-type': 'application/json' },
      body: JSON.stringify({ targetType: 'resource', targetId: 'resource-a' }),
    });
    assert.equal(duplicate.body.favorite.id, created.body.favorite.id);

    const listed = await json(baseUrl, '/api/user/favorites', { headers: { cookie: cookieA } });
    assert.deepEqual(listed.body.favorites.map((favorite) => favorite.id), [created.body.favorite.id]);

    const other = await json(baseUrl, '/api/user/favorites', { headers: { cookie: cookieB } });
    assert.deepEqual(other.body.favorites, []);

    const removed = await json(baseUrl, '/api/user/favorites/' + created.body.favorite.id, {
      method: 'DELETE',
      headers: { cookie: cookieA },
    });
    assert.equal(removed.response.status, 204);
    const afterDelete = await json(baseUrl, '/api/user/favorites', { headers: { cookie: cookieA } });
    assert.deepEqual(afterDelete.body.favorites, []);
  });
});

test('settings and account balance are stored and recharge writes billing transactions', async () => {
  await withApp(async (baseUrl) => {
    const cookie = await login(baseUrl, 'a@example.test', 'password-a');

    const settings = await json(baseUrl, '/api/user/settings', { headers: { cookie } });
    assert.equal(settings.body.settings.displayName, null);

    const updated = await json(baseUrl, '/api/user/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '客服 A', prefs: { defaultPanel: 'overview' } }),
    });
    assert.equal(updated.body.settings.displayName, '客服 A');
    assert.deepEqual(updated.body.settings.prefs, { defaultPanel: 'overview' });

    const invalid = await json(baseUrl, '/api/user/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 123 }),
    });
    assert.equal(invalid.response.status, 422);

    const renameOnly = await json(baseUrl, '/api/user/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '客服 A·组长' }),
    });
    assert.equal(renameOnly.body.settings.displayName, '客服 A·组长');
    assert.deepEqual(renameOnly.body.settings.prefs, { defaultPanel: 'overview' }, '仅更新昵称不应清空已保存的 prefs');

    const prefsOnly = await json(baseUrl, '/api/user/settings', {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prefs: { theme: 'dark' } }),
    });
    assert.deepEqual(prefsOnly.body.settings.prefs, { defaultPanel: 'overview', theme: 'dark' }, 'prefs 应增量合并而非整体替换');

    const account = await json(baseUrl, '/api/user/account', { headers: { cookie } });
    assert.equal(account.body.account.balanceCents, 0);

    const recharged = await json(baseUrl, '/api/user/billing/recharge', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ amountCents: 5000, remark: '测试充值' }),
    });
    assert.equal(recharged.response.status, 201);
    assert.equal(recharged.body.account.balanceCents, 5000);
    assert.equal(recharged.body.transaction.type, 'recharge');

    const transactions = await json(baseUrl, '/api/user/billing/transactions', { headers: { cookie } });
    assert.equal(transactions.body.transactions.length, 1);
    assert.equal(transactions.body.transactions[0].balanceAfterCents, 5000);

    const notifications = await json(baseUrl, '/api/user/notifications', { headers: { cookie } });
    assert.ok(notifications.body.notifications.some((item) => item.title === '充值成功'));
    assert.ok(notifications.body.unreadCount >= 1);

    const read = await json(baseUrl, '/api/user/notifications/read-all', { method: 'POST', headers: { cookie } });
    assert.equal(read.response.status, 200);
    const afterRead = await json(baseUrl, '/api/user/notifications', { headers: { cookie } });
    assert.equal(afterRead.body.unreadCount, 0);
  });
});

test('chat consumption deducts the balance and notifies when the balance goes negative', async () => {
  await withApp(async (baseUrl) => {
    const cookie = await login(baseUrl, 'a@example.test', 'password-a');
    await json(baseUrl, '/api/user/billing/recharge', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ amountCents: 5, remark: '小额充值' }),
    });

    const createdAgent = await json(baseUrl, '/api/user/agents', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '扣费测试 Agent' }),
    });
    assert.equal(createdAgent.response.status, 202);
    const agentId = createdAgent.body.agent.id;

    let agent = createdAgent.body.agent;
    for (let i = 0; i < 40 && agent.status !== 'ready'; i += 1) {
      await sleep(50);
      agent = (await json(baseUrl, '/api/user/agents/' + agentId, { headers: { cookie } })).body.agent;
    }
    assert.equal(agent.status, 'ready');

    const session = (await json(baseUrl, `/api/user/agents/${agentId}/sessions`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '扣费测试会话' }),
    })).body.session;

    const stream = await fetch(baseUrl + `/api/user/agents/${agentId}/sessions/${session.id}/chat/stream`, {
      method: 'POST',
      headers: { ...{ cookie }, accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(stream.status, 200);
    await stream.text();

    const account = (await json(baseUrl, '/api/user/account', { headers: { cookie } })).body.account;
    assert.equal(account.balanceCents, 5 - 10);

    const transactions = (await json(baseUrl, '/api/user/billing/transactions', { headers: { cookie } })).body.transactions;
    assert.ok(transactions.some((item) => item.type === 'consume' && item.amountCents === 10));

    const notifications = (await json(baseUrl, '/api/user/notifications', { headers: { cookie } })).body.notifications;
    assert.ok(notifications.some((item) => item.title === '账户余额不足'));
  });
});

test('filing records can be submitted and are scoped per user', async () => {
  await withApp(async (baseUrl) => {
    const cookie = await login(baseUrl, 'a@example.test', 'password-a');
    const cookieB = await login(baseUrl, 'b@example.test', 'password-b');

    const invalid = await json(baseUrl, '/api/user/filings', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'not-a-domain', subjectName: '测试主体' }),
    });
    assert.equal(invalid.response.status, 422);

    const created = await json(baseUrl, '/api/user/filings', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'agent-demo.bairui.app', subjectName: '示例科技有限公司', subjectType: 'enterprise', icpNumber: '京ICP备2026000001号' }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.filing.status, 'submitted');

    const listed = (await json(baseUrl, '/api/user/filings', { headers: { cookie } })).body.filings;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].domain, 'agent-demo.bairui.app');

    const otherFilings = (await json(baseUrl, '/api/user/filings', { headers: { cookie: cookieB } })).body.filings;
    assert.deepEqual(otherFilings, []);
  });
});
