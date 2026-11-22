import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const clientRoot = fileURLToPath(new URL('../apps/console-mvp/', import.meta.url));
const requireClient = createRequire(new URL('../apps/console-mvp/package.json', import.meta.url));
const load = name => import(pathToFileURL(requireClient.resolve(name)).href);
const oldPassword = 'auth-fixture-password-before';
const newPassword = 'auth-fixture-password-browser-after';

export async function checkAuthEmailBrowser({ start, waitFor, mails, registerOld, challenge }) {
  const [{ createServer }, { default: react }, { default: tailwind }, { chromium }] = await Promise.all([
    load('vite'), load('@vitejs/plugin-react'), load('@tailwindcss/vite'),
    import(pathToFileURL(process.env.BAIRUI_PLAYWRIGHT_MODULE).href),
  ]);
  const cache = await mkdtemp(join(tmpdir(), 'bairui-email-browser-'));
  let browser;
  const servers = [];
  const errors = [];

  async function consoleFor(mode) {
    const clientIP = mode === 'transition' ? '198.51.100.201' : '198.51.100.202';
    const proxy = { target: 'http://127.0.0.1:1', changeOrigin: true,
      configure: proxyServer => proxyServer.on('proxyReq', proxyRequest => proxyRequest.setHeader('x-forwarded-for', clientIP)) };
    const server = await createServer({
      root: clientRoot, cacheDir: join(cache, mode), configFile: false, envDir: false,
      plugins: [react(), tailwind()],
      server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, proxy: { '/api': proxy, '/healthz': proxy } },
    });
    servers.push(server);
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    proxy.target = await start(mode, origin);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    return { origin, context, page };
  }

  async function login(page, email, password) {
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.locator('.console-app').waitFor();
  }

  async function openMail(page, kind, email) {
    const { link } = await waitFor(() => mails(kind, email)[0], `${kind} message for the browser`);
    const secret = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
    assert.ok(secret);
    const leaked = [];
    const network = request => {
      if ([request.url(), request.headers().referer ?? ''].some(value => value.includes(secret))) leaked.push(true);
    };
    page.on('request', network);
    try {
      await page.goto(link);
      await page.getByRole('heading', { name: kind === 'reset' ? '重置密码' : '验证邮箱', exact: true }).waitFor();
      assert.equal(new URL(page.url()).hash, '');
      assert.equal(new URL(page.url()).search, '');
      assert.equal((await challenge(kind, email)).consumed_at, null);
      assert.equal(leaked.length, 0, 'The mail token never travels in the URL or Referer');
    } finally { page.off('request', network); }
    return link;
  }

  try {
    browser = await chromium.launch({ headless: true, ...(process.env.BAIRUI_BROWSER_EXECUTABLE
      ? { executablePath: process.env.BAIRUI_BROWSER_EXECUTABLE } : {}) });
    const transition = await consoleFor('transition');
    const oldEmail = 'browser-transition@example.test';
    await registerOld(oldEmail);
    await transition.page.goto(transition.origin);
    await transition.page.getByRole('button', { name: '忘记密码' }).waitFor();
    assert.equal(await transition.page.getByRole('tab', { name: '注册' }).count(), 0);
    await login(transition.page, oldEmail, oldPassword);
    const account = await (await transition.context.request.get(transition.origin + '/api/auth/me')).json();
    await transition.page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = transition.page.getByRole('dialog');
    await settings.getByText('邮箱未验证', { exact: true }).waitFor();
    const verificationRequest = transition.page.waitForRequest(request => request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/auth/email-verification/request');
    await settings.getByRole('button', { name: '申请验证邮件' }).click();
    assert.equal((await verificationRequest).headers()['x-bairui-expected-user'], account.user.userId);
    await settings.getByRole('status').waitFor();
    await openMail(transition.page, 'verify', oldEmail);
    await transition.page.getByRole('button', { name: '确认验证邮箱' }).click();
    await transition.page.getByText('邮箱验证成功，请登录。', { exact: true }).waitFor();
    assert.equal((await transition.context.request.get(transition.origin + '/api/auth/me')).status(), 401);
    await login(transition.page, oldEmail, oldPassword);
    await transition.page.getByRole('button', { name: '设置', exact: true }).click();
    await transition.page.getByRole('dialog').getByText('邮箱已验证', { exact: true }).waitFor();

    const enforce = await consoleFor('enforce');
    const email = 'browser-enforce@example.test';
    const { page, context, origin } = enforce;
    await page.goto(origin);
    await page.getByRole('tab', { name: '注册', exact: true }).click();
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page.getByLabel('密码', { exact: true }).fill(oldPassword);
    await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await page.getByText('请查收邮箱中的验证邮件，完成验证后登录。', { exact: true }).waitFor();
    assert.equal((await context.request.get(origin + '/api/auth/me')).status(), 401);
    await openMail(page, 'verify', email);
    await page.getByRole('button', { name: '确认验证邮箱' }).click();
    await page.getByText('邮箱验证成功，请登录。', { exact: true }).waitFor();
    await login(page, email, oldPassword);
    const cookie = (await context.cookies()).map(value => `${value.name}=${value.value}`).join('; ');
    assert.ok(cookie);
    const resetPage = await browser.newPage({ viewport: { width: 320, height: 780 } });
    resetPage.on('pageerror', error => errors.push(error.message));
    await resetPage.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await resetPage.goto(origin);
    await resetPage.getByRole('button', { name: '忘记密码' }).click();
    await resetPage.getByLabel('邮箱', { exact: true }).fill(email);
    await resetPage.getByRole('button', { name: '申请重置密码' }).click();
    await resetPage.getByText('如果该邮箱可接收账号邮件，请查收密码重置邮件。', { exact: true }).waitFor();
    const resetLink = await openMail(resetPage, 'reset', email);
    for (const width of [1440, 390, 320]) {
      await resetPage.setViewportSize({ width, height: 780 });
      assert.equal(await resetPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Reset layout at ${width}px`);
    }
    await resetPage.getByLabel('新密码', { exact: true }).fill(newPassword);
    await resetPage.getByLabel('确认新密码', { exact: true }).fill(oldPassword);
    const save = resetPage.getByRole('button', { name: '保存新密码' });
    await save.click();
    await resetPage.getByRole('alert').filter({ hasText: '两次输入的密码需一致。' }).waitFor();
    assert.equal((await challenge('reset', email)).consumed_at, null);
    await resetPage.getByLabel('确认新密码', { exact: true }).fill(newPassword);
    await save.click();
    await resetPage.getByText('密码已重置，请使用新密码登录。', { exact: true }).waitFor();
    assert.equal((await context.request.get(origin + '/api/auth/me', { headers: { cookie } })).status(), 401);
    await login(resetPage, email, newPassword);
    await resetPage.goto(resetLink);
    await resetPage.getByRole('button', { name: '保存新密码' }).waitFor();
    await resetPage.getByLabel('新密码', { exact: true }).fill(newPassword);
    await resetPage.getByLabel('确认新密码', { exact: true }).fill(newPassword);
    await resetPage.getByRole('button', { name: '保存新密码' }).click();
    await resetPage.getByText('链接无效或已过期。请申请新的邮件链接。', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await Promise.all(servers.map(server => server.close()));
    assert.equal(dirname(resolve(cache)), resolve(tmpdir()));
    await rm(cache, { recursive: true, force: true });
  }
}
