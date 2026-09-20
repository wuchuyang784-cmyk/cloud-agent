import test from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.mjs';

// 注册闭环以 local 身份模式运行：真实创建账号与个人组织，并签发会话。
async function withLocalApp(run) {
  const app = createApp({ env: { NODE_ENV: 'test', BAIRUI_PLATFORM_MODE: 'legacy' }, seed: {}, authOptions: { mode: 'local' } });
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    await run(`http://127.0.0.1:${server.address().port}`, app);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function json(baseUrl, path, options = {}) {
  const response = await fetch(baseUrl + path, { ...options, headers: { accept: 'application/json', ...options.headers } });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

function register(baseUrl, payload) {
  return json(baseUrl, '/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('注册创建真实个人组织、账号与会话', async () => {
  await withLocalApp(async (baseUrl, app) => {
    const created = await register(baseUrl, { email: 'New.User@Example.test', password: 'password-123', displayName: '新用户' });
    assert.equal(created.response.status, 201);

    const user = created.body.user;
    // 邮箱归一化为小写，注册者即个人组织的管理员。
    assert.equal(user.email, 'new.user@example.test');
    assert.equal(user.role, 'org_admin');
    const cookie = created.response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);

    // 多组织预留：注册即产生一个个人组织，organizationId 即当前激活组织。
    assert.equal(user.organizations.length, 1);
    assert.equal(user.organizations[0].id, user.organizationId);
    assert.equal(user.organizations[0].kind, 'personal');

    const organization = app.platform.store.organizations.get(user.organizationId);
    assert.equal(organization.kind, 'personal');
    assert.equal(app.platform.store.memberships.get(user.organizationId + ':' + user.userId).role, 'org_admin');

    // 会话直接可用。
    const me = await json(baseUrl, '/api/auth/me', { headers: { cookie } });
    assert.equal(me.response.status, 200);
    assert.equal(me.body.user.userId, user.userId);

    // 数据落在新建的个人组织里，而不是共享的种子组织。
    const agents = await json(baseUrl, '/api/user/agents', { headers: { cookie } });
    assert.equal(agents.response.status, 200);
    assert.deepEqual(agents.body.agents, []);
  });
});

test('注册用户可以登录，口令错误被拒绝', async () => {
  await withLocalApp(async (baseUrl) => {
    await register(baseUrl, { email: 'login@example.test', password: 'password-123' });

    const ok = await json(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'login@example.test', password: 'password-123' }),
    });
    assert.equal(ok.response.status, 200);
    assert.equal(ok.body.user.email, 'login@example.test');

    const bad = await json(baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'login@example.test', password: 'wrong-password' }),
    });
    assert.equal(bad.response.status, 401);
    assert.equal(bad.body.error.code, 'invalid_credentials');
  });
});

test('邮箱重复注册返回冲突（大小写不敏感）', async () => {
  await withLocalApp(async (baseUrl) => {
    await register(baseUrl, { email: 'dup@example.test', password: 'password-123' });
    const again = await register(baseUrl, { email: 'DUP@Example.test', password: 'password-456' });
    assert.equal(again.response.status, 409);
    assert.equal(again.body.error.code, 'email_taken');
  });
});

test('注册校验邮箱格式与口令长度', async () => {
  await withLocalApp(async (baseUrl) => {
    const badEmail = await register(baseUrl, { email: 'not-an-email', password: 'password-123' });
    assert.equal(badEmail.response.status, 422);
    assert.equal(badEmail.body.error.code, 'validation_error');

    const shortPassword = await register(baseUrl, { email: 'short@example.test', password: 'short' });
    assert.equal(shortPassword.response.status, 422);
  });
});

test('注册用户的个人组织互相隔离', async () => {
  await withLocalApp(async (baseUrl) => {
    const first = await register(baseUrl, { email: 'first@example.test', password: 'password-123' });
    const second = await register(baseUrl, { email: 'second@example.test', password: 'password-123' });
    assert.notEqual(first.body.user.organizationId, second.body.user.organizationId);

    const cookie = first.response.headers.get('set-cookie');
    const agent = await json(baseUrl, '/api/user/agents', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '隔离验证 Agent' }),
    });
    assert.equal(agent.response.status, 202);

    const mine = await json(baseUrl, '/api/user/agents', { headers: { cookie } });
    assert.equal(mine.body.agents.length, 1);

    // 另一个注册用户看不到对方的 Agent。
    const other = await json(baseUrl, '/api/user/agents', { headers: { cookie: second.response.headers.get('set-cookie') } });
    assert.deepEqual(other.body.agents, []);
  });
});
