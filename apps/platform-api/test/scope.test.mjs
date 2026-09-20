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
      agents: [
        { id: 'agent-a', ownerUserId: 'user-a', organizationId: 'org-a', name: 'A agent', status: 'ready' },
        { id: 'agent-b', ownerUserId: 'user-b', organizationId: 'org-b', name: 'B agent', status: 'ready' },
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
  const body = await response.json();
  return { response, body };
}

test('local login issues an httpOnly session cookie and lists only the current user agents', async () => {
  await withApp(async (baseUrl) => {
    const login = await json(`${baseUrl}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.test', password: 'password-a' }),
    });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);

    const agents = await json(`${baseUrl}/api/user/agents`, { headers: { cookie } });
    assert.equal(agents.response.status, 200);
    assert.deepEqual(agents.body.agents.map((agent) => agent.id), ['agent-a']);
  });
});

test('agent routes return not found for another users agent instead of leaking existence', async () => {
  await withApp(async (baseUrl) => {
    const login = await json(`${baseUrl}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.test', password: 'password-a' }),
    });
    const cookie = login.response.headers.get('set-cookie');
    const otherAgent = await json(`${baseUrl}/api/user/agents/agent-b`, { headers: { cookie } });
    assert.equal(otherAgent.response.status, 404);
    assert.equal(otherAgent.body.error.code, 'agent_not_found');
  });
});

test('user endpoints reject requests without a principal', async () => {
  await withApp(async (baseUrl) => {
    const agents = await json(`${baseUrl}/api/user/agents`);
    assert.equal(agents.response.status, 401);
    assert.equal(agents.body.error.code, 'unauthenticated');
  });
});

test('local startup provides a development principal', async () => {
  const app = createApp({ env: { NODE_ENV: 'test', BAIRUI_PLATFORM_MODE: 'legacy' } });
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await json(`${baseUrl}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dev@example.test', password: 'dev-password-change-me' }),
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.body.user.userId, 'dev-user');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
