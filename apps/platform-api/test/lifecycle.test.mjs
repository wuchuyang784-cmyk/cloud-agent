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
    },
  });
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    await run(`http://127.0.0.1:${server.address().port}`, app);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  const body = await response.json();
  return { response, body };
}

async function login(baseUrl, email = 'a@example.test', password = 'password-a') {
  const result = await json(`${baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200);
  return result.response.headers.get('set-cookie');
}

test('agent creation is asynchronous and mock runtime makes it ready', async () => {
  await withApp(async (baseUrl, app) => {
    const cookie = await login(baseUrl);
    const created = await json(`${baseUrl}/api/user/agents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'create-agent-1' },
      body: JSON.stringify({ name: 'Support agent' }),
    });
    assert.equal(created.response.status, 202);
    assert.equal(created.body.agent.status, 'provisioning');
    assert.equal(created.body.agent.name, 'Support agent');
    assert.equal(app.platform.store.outbox.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const ready = await json(`${baseUrl}/api/user/agents/${created.body.agent.id}`, { headers: { cookie } });
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.agent.status, 'ready');
    assert.equal(ready.body.agent.host, `agent-${created.body.agent.id.replace(/^agent-/, '')}.localhost`);
  });
});

test('idempotency is scoped to the user and rejects a reused key with a different request', async () => {
  await withApp(async (baseUrl) => {
    const cookie = await login(baseUrl);
    const first = await json(`${baseUrl}/api/user/agents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'same-key' },
      body: JSON.stringify({ name: 'One agent' }),
    });
    const replay = await json(`${baseUrl}/api/user/agents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'same-key' },
      body: JSON.stringify({ name: 'One agent' }),
    });
    assert.equal(replay.response.status, 202);
    assert.equal(replay.body.agent.id, first.body.agent.id);

    const conflict = await json(`${baseUrl}/api/user/agents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'idempotency-key': 'same-key' },
      body: JSON.stringify({ name: 'A different agent' }),
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, 'idempotency_conflict');
  });
});

test('chat stream is scoped to the user and returns runtime events plus usage', async () => {
  await withApp(async (baseUrl) => {
    const cookie = await login(baseUrl);
    const agent = await json(`${baseUrl}/api/user/agents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Chat agent' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const session = await json(`${baseUrl}/api/user/agents/${agent.body.agent.id}/sessions`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'First chat' }),
    });
    assert.equal(session.response.status, 201);

    const stream = await fetch(`${baseUrl}/api/user/agents/${agent.body.agent.id}/sessions/${session.body.session.id}/chat/stream`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const text = await stream.text();
    assert.match(text, /event: run.started/);
    assert.match(text, /event: message.completed/);
    assert.match(text, /event: run.completed/);
    assert.match(text, /模拟 Runtime 已收到：你好/);

    const history = await json(`${baseUrl}/api/user/agents/${agent.body.agent.id}/sessions/${session.body.session.id}/messages`, { headers: { cookie } });
    assert.equal(history.response.status, 200);
    assert.deepEqual(history.body.messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(history.body.messages[0].content, '你好');
    assert.match(history.body.messages[1].content, /模拟 Runtime 已收到：你好/);

    const usage = await json(`${baseUrl}/api/user/usage?range=today`, { headers: { cookie } });
    assert.equal(usage.response.status, 200);
    assert.ok(usage.body.summary.totalTokens > 0);
    assert.equal(usage.body.summary.activeAgents, 1);
  });
});

test('cross-user session access returns the same hidden-agent not found response', async () => {
  await withApp(async (baseUrl) => {
    const userACookie = await login(baseUrl);
    const created = await json(`${baseUrl}/api/user/agents`, {
      method: 'POST',
      headers: { cookie: userACookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Private agent' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const session = await json(`${baseUrl}/api/user/agents/${created.body.agent.id}/sessions`, {
      method: 'POST',
      headers: { cookie: userACookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const userBCookie = await login(baseUrl, 'b@example.test', 'password-b');
    const response = await json(`${baseUrl}/api/user/agents/${created.body.agent.id}/sessions/${session.body.session.id}/chat/stream`, {
      method: 'POST',
      headers: { cookie: userBCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'should be blocked' }),
    });
    assert.equal(response.response.status, 404);
    assert.equal(response.body.error.code, 'agent_not_found');

    const history = await json(`${baseUrl}/api/user/agents/${created.body.agent.id}/sessions/${session.body.session.id}/messages`, {
      method: 'GET',
      headers: { cookie: userBCookie },
    });
    assert.equal(history.response.status, 404);
    assert.equal(history.body.error.code, 'agent_not_found');
  });
});
