import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build, preview } from 'vite';

const playwright = process.env.BAIRUI_PLAYWRIGHT_MODULE;
const token = 'A'.repeat(43);
const capabilities = { mode: 'platform', agentLifecycle: false, agentExecution: false, simulatedRecharge: false };
const user = { userId: 'other-user', organizationId: 'personal', role: 'owner', email: 'other@example.test', accountStatus: 'active', emailVerified: false };

test('email authentication in the console', { skip: !playwright && 'Set BAIRUI_PLAYWRIGHT_MODULE to run the browser fixture', timeout: 90000 }, async t => {
  const { chromium } = await import(pathToFileURL(playwright).href);
  const outDir = await mkdtemp(join(tmpdir(), 'bairui-console-email-'));
  const config = {
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    build: { outDir },
  };
  let server;
  t.after(async () => {
    await server?.close();
    await rm(outDir, { recursive: true, force: true });
  });
  await build({ ...config, plugins: [react()] });
  server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.BAIRUI_BROWSER_EXECUTABLE });
  t.after(() => browser.close());

  async function fixture(t, { emailMode, signedIn = false, responses = {} }) {
    const page = await browser.newPage();
    t.after(() => page.close());
    page.setDefaultTimeout(4000);
    const calls = [];
    const defaults = {
      '/api/auth/config': [200, { provider: 'better-auth', emailMode, capabilities }],
      '/api/auth/me': signedIn ? [200, { user }] : [401, { error: { code: 'unauthenticated' } }],
      '/api/user/agents': [200, { agents: [] }],
      '/api/user/resources': [200, { resources: [] }],
      '/api/user/usage': [200, { summary: { totalTokens: 0, totalCalls: 0, activeAgents: 0 } }],
      '/api/user/favorites': [200, { favorites: [] }],
      '/api/user/settings': [200, { settings: { displayName: null, prefs: {} } }],
      '/api/user/account': [200, { account: null }],
      '/api/user/billing/transactions': [200, { transactions: [] }],
      '/api/user/filings': [200, { filings: [] }],
      '/api/user/notifications': [200, { notifications: [], unreadCount: 0, nextCursor: null }],
      '/api/user/notifications/unread-count': [200, { unreadCount: 0 }],
      '/healthz': [200, { status: 'ok', database: 'postgres' }],
    };
    await page.route(url => url.origin === origin && (url.pathname.startsWith('/api/') || url.pathname === '/healthz'), async route => {
      const path = new URL(route.request().url()).pathname;
      const headers = route.request().headers();
      calls.push({ path, body: route.request().postDataJSON(), referer: headers.referer });
      if (/^\/api\/auth\/(email-verification|password-reset)\//.test(path) && headers.origin !== origin) {
        await route.fulfill({ status: 403, json: { error: { code: 'origin_rejected' } } });
        return;
      }
      const [status, json] = responses[path] ?? defaults[path] ?? [404, {}];
      await route.fulfill({ status, json });
    });
    return { page, calls };
  }

  await t.test('older auth config keeps registration and hides forgot password', async t => {
    const { page } = await fixture(t, {});
    await page.goto(origin);
    await page.getByRole('tab', { name: '注册' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '忘记密码' }).count(), 0);
    await page.getByLabel('密码', { exact: true }).fill('password-12345');
    await page.getByRole('tab', { name: '注册' }).click();
    assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), 'password-12345');
  });

  await t.test('a transient auth config failure can recover without reloading the console', async t => {
    const responses = { '/api/auth/config': [503, { error: { code: 'database_unavailable' } }] };
    const { page } = await fixture(t, { responses });
    await page.goto(origin);
    const retry = page.getByRole('button', { name: '重试认证配置' });
    await retry.waitFor();
    assert.equal(await page.getByRole('tab', { name: '注册' }).count(), 0);
    responses['/api/auth/config'] = [200, { provider: 'better-auth', emailMode: 'enforce', capabilities }];
    await retry.click();
    await page.getByRole('tab', { name: '注册' }).waitFor();
    await page.getByRole('button', { name: '忘记密码' }).waitFor();
    assert.equal(await retry.count(), 0);
  });

  await t.test('transition hides registration and shows a generic password reset response', async t => {
    const { page, calls } = await fixture(t, { emailMode: 'transition', responses: { '/api/auth/password-reset/request': [202, { accepted: true }] } });
    await page.goto(origin);
    await page.getByRole('button', { name: '忘记密码' }).click();
    assert.equal(await page.getByRole('tab', { name: '注册' }).count(), 0);
    await page.getByLabel('邮箱').fill('new@example.test');
    await page.getByRole('button', { name: '申请重置密码' }).click();
    await page.getByRole('status').filter({ hasText: /如果.*邮箱.*密码重置/ }).waitFor();
    assert.deepEqual(calls.find(call => call.path.endsWith('/request'))?.body, { email: 'new@example.test' });
  });

  await t.test('transition shows unverified email in personal settings without changing profile fields', async t => {
    const { page, calls } = await fixture(t, { emailMode: 'transition', signedIn: true, responses: { '/api/auth/email-verification/request': [202, { accepted: true }] } });
    await page.goto(origin);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByText('邮箱未验证').waitFor();
    await settings.getByRole('button', { name: '申请验证邮件' }).click();
    await settings.getByRole('status').filter({ hasText: /如果.*验证邮件/ }).waitFor();
    assert.deepEqual(calls.find(call => call.path.endsWith('/request'))?.body, {});
    assert.equal(await settings.getByLabel('显示昵称').count(), 1);
  });

  await t.test('enforced registration goes back to login and asks the user to check their inbox', async t => {
    const { page, calls } = await fixture(t, { emailMode: 'enforce', responses: { '/api/auth/sign-up/email': [200, { token: null }] } });
    await page.goto(origin);
    await page.getByRole('tab', { name: '注册' }).click();
    const initialMeCalls = calls.filter(call => call.path === '/api/auth/me').length;
    await page.getByLabel('邮箱').fill('new@example.test');
    await page.getByLabel('密码', { exact: true }).fill('password-12345');
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await page.getByRole('heading', { name: '登录控制台' }).waitFor();
    await page.getByRole('status').filter({ hasText: /查收.*验证邮件/ }).waitFor();
    assert.equal(calls.filter(call => call.path === '/api/auth/me').length, initialMeCalls);
    assert.equal(await page.getByLabel('密码', { exact: true }).inputValue(), '');
  });

  await t.test('unverified login explains the limited email request', async t => {
    const { page } = await fixture(t, { emailMode: 'enforce', responses: { '/api/auth/sign-in/email': [403, { error: { code: 'email_not_verified' } }] } });
    await page.goto(origin);
    await page.getByLabel('邮箱').fill('new@example.test');
    await page.getByLabel('密码', { exact: true }).fill('password-12345');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /邮箱尚未验证.*发送频率/ }).waitFor();
  });

  await t.test('verification removes the fragment, waits for confirmation, then shows sign-in with another account cookie present', async t => {
    const path = '/api/auth/email-verification/confirm';
    const { page, calls } = await fixture(t, { emailMode: 'transition', signedIn: true, responses: { [path]: [200, { ok: true }] } });
    await page.goto(`${origin}/auth/verify#token=${token}`);
    await page.getByRole('heading', { name: '验证邮箱' }).waitFor();
    assert.equal(page.url(), `${origin}/auth/verify`);
    assert.equal(calls.some(call => call.path === path), false);
    await page.getByRole('button', { name: '确认验证邮箱' }).click();
    await page.getByRole('heading', { name: '登录控制台' }).waitFor();
    await page.getByRole('status').filter({ hasText: /邮箱验证成功/ }).waitFor();
    assert.deepEqual(calls.find(call => call.path === path)?.body, { token });
    assert.equal(calls.find(call => call.path === path)?.referer, `${origin}/auth/verify`);
    assert.equal(calls.some(call => call.path === '/api/auth/me'), false);
  });

  await t.test('reset requires matching valid passwords and stays on the sign-in flow after completion', async t => {
    const path = '/api/auth/password-reset/confirm';
    const { page, calls } = await fixture(t, { emailMode: 'enforce', signedIn: true, responses: { [path]: [200, { ok: true }] } });
    await page.goto(`${origin}/auth/reset#token=${token}`);
    await page.getByRole('heading', { name: '重置密码' }).waitFor();
    assert.equal(page.url(), `${origin}/auth/reset`);
    const password = page.getByLabel('新密码', { exact: true });
    const confirm = page.getByLabel('确认新密码');
    const submit = page.getByRole('button', { name: '保存新密码' });
    await password.fill('short');
    await confirm.fill('short');
    await submit.click();
    await page.getByRole('alert').filter({ hasText: /12.*128/ }).waitFor();
    await password.fill('new-password-123');
    await submit.click();
    await page.getByRole('alert').filter({ hasText: /两次.*密码.*一致/ }).waitFor();
    assert.equal(calls.some(call => call.path === path), false);
    await confirm.fill('new-password-123');
    await submit.click();
    await page.getByRole('status').filter({ hasText: /密码已重置/ }).waitFor();
    assert.deepEqual(calls.find(call => call.path === path)?.body, { token, newPassword: 'new-password-123' });
    assert.equal(calls.some(call => call.path === '/api/auth/me'), false);
  });

  await t.test('invalid and expired links display the same message without leaving a token in the URL', async t => {
    const path = '/api/auth/email-verification/confirm';
    const { page, calls } = await fixture(t, { emailMode: 'enforce', responses: { [path]: [400, { error: { code: 'invalid_or_expired_link' } }] } });
    await page.goto(`${origin}/auth/verify#token=malformed`);
    const warning = page.getByRole('alert').filter({ hasText: /链接无效或已过期/ });
    await warning.waitFor();
    assert.equal(page.url(), `${origin}/auth/verify`);
    assert.equal(calls.some(call => call.path === path), false);
    await page.goto(`${origin}/auth/verify#token=${token}`);
    await page.getByRole('button', { name: '确认验证邮箱' }).click();
    await warning.waitFor();
    assert.equal(await page.getByRole('button', { name: '确认验证邮箱' }).count(), 0);
  });
});
