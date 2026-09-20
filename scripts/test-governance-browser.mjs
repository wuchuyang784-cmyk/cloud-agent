import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../apps/platform-api/src/app.mjs';
import { PostgresStore } from '../apps/platform-api/src/postgres-store.mjs';
import { waitForPostgres } from './postgres-ready.mjs';

// Explicit opt-in, isolated database and test identities; no business .env or Swarm changes.
if (!process.env.BAIRUI_PLAYWRIGHT_MODULE) throw new Error('Set BAIRUI_PLAYWRIGHT_MODULE to an installed Playwright entrypoint.');
const root = fileURLToPath(new URL('../', import.meta.url));
const { Pool, Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const requireAdmin = createRequire(new URL('../apps/admin-console/package.json', import.meta.url));
const vite = await import(pathToFileURL(requireAdmin.resolve('vite')).href);
const { chromium } = await import(pathToFileURL(process.env.BAIRUI_PLAYWRIGHT_MODULE).href);
const exec = promisify(execFile);
const name = 'bairui-governance-browser-' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex'), loginPassword = randomBytes(20).toString('hex');
const env = { ...process.env, POSTGRES_PASSWORD: password };
for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$)/.test(key)) delete env[key];
const temp = await mkdtemp(join(tmpdir(), 'bairui-governance-browser-'));
const output = join(root, 'output/playwright/admin-phase-d1');
await mkdir(output, { recursive: true });
let created = false, owner, pool, app, admin, client, browser, page, userPage;
async function configFor(directory) {
  const previous = process.cwd();
  try {
    process.chdir(temp);
    return (await vite.loadConfigFromFile({ command: 'serve', mode: 'test' }, join(root, directory, 'vite.config.ts'), temp, undefined, undefined, 'native')).config;
  } finally { process.chdir(previous); }
}
try {
  await exec('docker', ['run', '--rm', '-d', '--name', name, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=governance_check', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.2-pg17-bookworm'], { env, windowsHide: true, timeout: 120000 });
  created = true;
  const { stdout } = await exec('docker', ['inspect', name], { windowsHide: true, timeout: 10000 });
  const port = JSON.parse(stdout)[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/governance_check`;
  await waitForPostgres(() => new Client({ connectionString, connectionTimeoutMillis: 2000 }));
  owner = new Pool({ connectionString });
  for (const migration of (await readdir(join(root, 'packages/db/migrations'))).filter(n => n.endsWith('.sql') && !n.startsWith('033')).sort()) {
    await owner.query(await readFile(join(root, 'packages/db/migrations', migration), 'utf8'));
  }
  await owner.query('CREATE ROLE governance_browser_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await owner.query('GRANT USAGE ON SCHEMA public TO governance_browser_app');
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO governance_browser_app');
  await owner.query('REVOKE ALL ON platform_role_bindings,platform_admin_audit,platform_infrastructure_sources,platform_infrastructure_snapshots,platform_account_governance,platform_governance_audit FROM governance_browser_app');
  await owner.query('GRANT EXECUTE ON FUNCTION platform_admin_read(text,text,text,text,integer,text,text),platform_account_access(text),platform_account_session_allowed(text),platform_governance_accounts(text,text[]),platform_governance_read(text,text,bigint),platform_governance_change(text,text,text,integer,text,uuid) TO governance_browser_app');
  pool = new Pool({ connectionString, options: '-c role=governance_browser_app' });
  const adminConfig = await configFor('apps/admin-console');
  admin = await vite.createServer({ ...adminConfig, root: join(root, 'apps/admin-console'), configFile: false, envDir: false,
    cacheDir: join(temp, 'admin-cache'), server: { ...adminConfig.server, port: 0, hmr: false } });
  await admin.listen();
  const clientConfig = await configFor('apps/console-mvp');
  const apiProxy = { target: 'http://127.0.0.1:1', changeOrigin: true };
  client = await vite.createServer({ ...clientConfig, root: join(root, 'apps/console-mvp'), configFile: false, envDir: false,
    cacheDir: join(temp, 'client-cache'), server: { ...clientConfig.server, port: 0, hmr: false,
      proxy: { '/admin': { target: 'http://127.0.0.1:' + admin.httpServer.address().port }, '/api': apiProxy, '/healthz': apiProxy } } });
  await client.listen();
  const origin = 'http://127.0.0.1:' + client.httpServer.address().port;
  app = createApp({ env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: randomBytes(32).toString('hex') }, store: new PostgresStore({ pool }) });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  apiProxy.target = 'http://127.0.0.1:' + app.address().port;
  for (const email of ['govern-admin@example.test', 'govern-user@example.test', 'govern-viewer@example.test']) {
    const response = await fetch(apiProxy.target + '/api/auth/sign-up/email', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: loginPassword, name: email.split('@')[0] }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
    assert.equal((await fetch(apiProxy.target + '/api/auth/me', { headers: { cookie } })).status, 200);
  }
  await owner.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) SELECT id,CASE WHEN email='govern-admin@example.test' THEN 'platform_admin' ELSE 'platform_viewer' END,'browser-check','disposable test' FROM users WHERE email IN ('govern-admin@example.test','govern-viewer@example.test')");
  browser = await chromium.launch({ headless: true, ...(process.env.BAIRUI_BROWSER_EXECUTABLE ? { executablePath: process.env.BAIRUI_BROWSER_EXECUTABLE } : {}) });
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const userContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await adminContext.newPage();
  userPage = await userContext.newPage();
  const errors = [];
  for (const p of [page, userPage]) p.on('pageerror', error => errors.push(error.message));
  async function login(p, email, path, expectedStatus = 200) {
    await p.goto(origin + path);
    await p.getByLabel('邮箱', { exact: true }).fill(email);
    await p.getByLabel('密码', { exact: true }).fill(loginPassword);
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = p.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/sign-in/email');
      await p.getByRole('button', { name: '登录', exact: true }).click();
      const response = await pending;
      if (response.status() !== 429 || attempt === 2) {
        assert.equal(response.status(), expectedStatus, 'sign-in status for ' + email);
        return;
      }
      const seconds = Number(response.headers()['retry-after']);
      assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 60, 'bounded Retry-After required');
      console.log('Login rate limit: retrying after ' + (seconds + 1) + ' seconds.');
      await new Promise(resolve => setTimeout(resolve, (seconds + 1) * 1000));
    }
  }
  await login(page, 'govern-admin@example.test', '/admin/');
  await page.getByRole('heading', { name: '用户账号', exact: true }).waitFor();
  await page.locator('main.content[aria-busy="false"]').waitFor();
  await login(userPage, 'govern-user@example.test', '/');
  await userPage.locator('.console-app').waitFor();
  const write = () => userContext.request.post(origin + '/api/user/resources', { headers: { origin }, data: { kind: 'skill', name: '保留的资源' } });
  assert.equal((await write()).status(), 201);
  const oldCookies = (await userContext.cookies()).map(c => c.name + '=' + c.value).join('; ');
  await page.getByRole('button', { name: '治理 govern-user@example.test', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '账号治理' });
  await dialog.getByText('正常', { exact: true }).waitFor();
  async function govern(status, reason, label) {
    await dialog.getByLabel('账号操作', { exact: true }).selectOption(status);
    await dialog.getByLabel('操作原因', { exact: true }).fill(reason);
    await dialog.getByRole('button', { name: '确认操作', exact: true }).click();
    await dialog.getByText('操作已确认', { exact: true }).waitFor();
    await dialog.locator('.governance-current').getByText(label, { exact: true }).waitFor();
  }
  await govern('suspended', '浏览器验收：暂停服务', '服务暂停');
  assert.equal((await write()).status(), 403);
  assert.equal((await userContext.request.get(origin + '/api/user/resources')).status(), 200);
  await userPage.reload();
  await userPage.locator('.account-restriction').waitFor();
  await page.screenshot({ path: join(output, 'governance-desktop.png'), fullPage: true });
  await userPage.screenshot({ path: join(output, 'client-suspended-desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'admin page overflow at ' + width);
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'dialog overflow at ' + width);
    await page.screenshot({ path: join(output, 'governance-mobile-' + width + '.png'), fullPage: true });
    await userPage.setViewportSize({ width, height: 844 });
    await userPage.screenshot({ path: join(output, 'client-suspended-mobile-' + width + '.png'), fullPage: true });
    const overflow = await userPage.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll('.console-topbar, .console-topbar-left, .console-topbar-right, .console-layout, .console-main, .account-restriction')]
        .map(el => ({ class: el.className, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })) }));
    assert.ok(overflow.scroll <= width, 'client page overflow: ' + JSON.stringify(overflow));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await govern('banned', '浏览器验收：封禁账号', '已封禁');
  assert.equal((await userContext.request.get(origin + '/api/auth/me')).status(), 401);
  await login(userPage, 'govern-user@example.test', '/', 403);
  await userPage.getByRole('alert').filter({ hasText: '账号已封禁' }).waitFor();
  await userPage.screenshot({ path: join(output, 'client-banned.png'), fullPage: true });
  await govern('active', '浏览器验收：解除限制', '正常');
  assert.equal((await fetch(apiProxy.target + '/api/auth/me', { headers: { cookie: oldCookies } })).status, 401);
  assert.equal(await dialog.locator('.governance-history li').count(), 3);
  await page.screenshot({ path: join(output, 'governance-restored.png'), fullPage: true });
  await login(userPage, 'govern-user@example.test', '/');
  await userPage.locator('.console-app').waitFor();
  assert.equal(await userPage.locator('.account-restriction').count(), 0);
  assert.equal((await (await userContext.request.get(origin + '/api/user/resources')).json()).resources.length, 1);
  assert.equal((await userContext.request.post(origin + '/api/user/agents', { headers: { origin }, data: {} })).status(), 403);
  await userPage.goto(origin + '/admin/');
  await userPage.getByRole('heading', { name: '无管理端访问权限' }).waitFor();
  await dialog.getByRole('button', { name: '关闭账号治理' }).click();
  await page.getByRole('button', { name: '退出账号', exact: true }).click();
  await login(page, 'govern-viewer@example.test', '/admin/');
  await page.getByRole('button', { name: '治理 govern-user@example.test', exact: true }).click();
  await dialog.getByText('正常', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '确认操作', exact: true }).count(), 0);
  assert.equal(await dialog.locator('.governance-history li').count(), 3);
  assert.deepEqual(errors, []);
  console.log('PASS: real Better Auth -> admin governance -> PostgreSQL -> client suspension/ban/re-login; retained resources, revoked old sessions, viewer read-only, ordinary-user rejection, desktop/390/320.');
  console.log('Screenshots: output/playwright/admin-phase-d1');
} catch (error) {
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  if (userPage) {
    await userPage.screenshot({ path: join(output, 'failure-client.png'), fullPage: true }).catch(() => {});
    console.error('Client alerts:', await userPage.getByRole('alert').allTextContents().catch(() => []));
  }
  throw error;
} finally {
  await browser?.close(); await client?.close(); await admin?.close();
  if (app) await new Promise(r => app.close(r));
  await pool?.end(); await owner?.end();
  if (created) await exec('docker', ['rm', '-f', name], { windowsHide: true, timeout: 30000 });
  assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
  assert.ok(resolve(temp).startsWith(join(resolve(tmpdir()), 'bairui-governance-browser-')));
  await rm(temp, { recursive: true, force: true });
}
