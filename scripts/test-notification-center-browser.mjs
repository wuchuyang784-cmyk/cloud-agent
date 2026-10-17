import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../apps/platform-api/src/app.mjs';
import { PostgresStore } from '../apps/platform-api/src/postgres-store.mjs';
import { waitForPostgres } from './postgres-ready.mjs';

// Dedicated disposable identities, credentials, ports, caches and PostgreSQL; never read business .env.
if (!process.env.BAIRUI_PLAYWRIGHT_MODULE) throw new Error('Set BAIRUI_PLAYWRIGHT_MODULE to an installed Playwright entrypoint.');
const root = fileURLToPath(new URL('../', import.meta.url));
const { Pool, Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const requireClient = createRequire(new URL('../apps/console-mvp/package.json', import.meta.url));
const vite = await import(pathToFileURL(requireClient.resolve('vite')).href);
const react = (await import(pathToFileURL(requireClient.resolve('@vitejs/plugin-react')).href)).default;
const tailwind = (await import(pathToFileURL(requireClient.resolve('@tailwindcss/vite')).href)).default;
const { chromium } = await import(pathToFileURL(process.env.BAIRUI_PLAYWRIGHT_MODULE).href);
const exec = promisify(execFile), name = 'bairui-notifications-browser-' + randomBytes(8).toString('hex');
const password = randomBytes(24).toString('hex'), appPassword = randomBytes(24).toString('hex'), loginPassword = randomBytes(24).toString('hex');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|PG)/.test(key)) delete env[key];
env.POSTGRES_PASSWORD = password;
const temp = await mkdtemp(join(tmpdir(), 'bairui-notifications-browser-'));
const output = join(root, 'output/playwright/announcements-c', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
let container, owner, pool, app, web, adminWeb, browser, alice, bob, admin;
const checks = [], errors = [];
try {
  const result = await exec('docker', ['run', '--rm', '-d', '--name', name, '--label', 'bairui.test=notifications-browser', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=notifications_browser', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.2-pg17-bookworm'], { env, windowsHide: true, timeout: 120000 });
  container = result.stdout.trim(); assert.match(container, /^[0-9a-f]{64}$/);
  const info = JSON.parse((await exec('docker', ['inspect', container], { windowsHide: true })).stdout)[0];
  const connectionString = 'postgresql://postgres:' + password + '@127.0.0.1:' + info.NetworkSettings.Ports['5432/tcp'][0].HostPort + '/notifications_browser';
  await waitForPostgres(() => new Client({ connectionString, connectionTimeoutMillis: 2000 }));
  owner = new Pool({ connectionString });
  for (const file of (await readdir(join(root, 'packages/db/migrations'))).filter(n => n.endsWith('.sql') && !['033','035','038','039','040'].includes(n.slice(0,3))).sort()) await owner.query(await readFile(join(root, 'packages/db/migrations', file), 'utf8'));
  await owner.query("CREATE ROLE notification_browser_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + appPassword + "'");
  await owner.query('GRANT USAGE ON SCHEMA public TO notification_browser_app');
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO notification_browser_app');
  await owner.query('REVOKE ALL ON platform_role_bindings,platform_admin_audit,platform_account_governance,platform_governance_audit,platform_announcements,platform_announcement_receipts,platform_announcement_audit,platform_announcement_requests,platform_notification_center_requests FROM notification_browser_app');
  await owner.query('GRANT EXECUTE ON FUNCTION platform_admin_read(text,text,text,text,integer,text,text),platform_account_access(text),platform_account_session_allowed(text),platform_governance_accounts(text,text[]),platform_governance_read(text,text,bigint),platform_governance_change(text,text,text,integer,text,uuid),platform_announcement_change(text,jsonb),platform_announcement_read(text,jsonb),platform_announcement_user_read(text,text,jsonb),platform_notification_center_read(text,text,jsonb),platform_notification_center_mark(text,text,text),platform_notification_center_all(text,text,uuid) TO notification_browser_app');
  const restricted = new URL(connectionString); restricted.username = 'notification_browser_app'; restricted.password = appPassword;
  pool = new Pool({ connectionString: restricted.href });
  const api = { target: 'http://127.0.0.1:1' };
  adminWeb = await vite.createServer({ root: join(root, 'apps/admin-console'), base: '/admin/', configFile: false, envDir: false, plugins: [react()], cacheDir: join(temp, 'admin-cache'), server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, proxy: { '/api': api } } });
  await adminWeb.listen();
  web = await vite.createServer({ root: join(root, 'apps/console-mvp'), configFile: false, envDir: false, define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('') }, plugins: [react(), tailwind()], cacheDir: join(temp, 'client-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, proxy: { '/admin': { target: 'http://127.0.0.1:' + adminWeb.httpServer.address().port }, '/api': api, '/healthz': api } } });
  await web.listen(); const origin = 'http://127.0.0.1:' + web.httpServer.address().port;
  app = createApp({ env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: randomBytes(32).toString('hex') }, store: new PostgresStore({ pool }) });
  await new Promise(r => app.listen(0, '127.0.0.1', r)); api.target = 'http://127.0.0.1:' + app.address().port;
  async function waitLimit(headers) {
    const seconds = Number(headers['retry-after'] ?? headers.get?.('retry-after'));
    assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 60);
    console.log('Respecting authentication Retry-After: ' + seconds + ' seconds.');
    await new Promise(r => setTimeout(r, Math.min(seconds + 1, 60) * 1000));
  }
  async function register(email) {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(api.target + '/api/auth/sign-up/email', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email.split('@')[0], password: loginPassword }) });
      if (response.status !== 429 || attempt === 2) break;
      await response.text(); await waitLimit(response.headers);
    }
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
    const me = await fetch(api.target + '/api/auth/me', { headers: { cookie } }); assert.equal(me.status, 200);
    return { ...(await me.json()).user, cookie };
  }
  const accounts = {};
  for (const who of ['admin', 'alice', 'bob']) accounts[who] = await register('center-' + who + '@example.test');
  await owner.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES($1,'platform_admin','fixture','disposable')", [accounts.admin.userId]);
  for (const who of ['alice', 'bob']) await owner.query("INSERT INTO user_notifications(id,organization_id,user_id,type,title,body) VALUES($1,$2,$3,'system',$4,$5)", ['private-' + who, accounts[who].organizationId, accounts[who].userId, who + ' 私人通知', who + ' 本人的正文']);
  browser = await chromium.launch({ headless: true, ...(process.env.BAIRUI_BROWSER_EXECUTABLE ? { executablePath: process.env.BAIRUI_BROWSER_EXECUTABLE } : {}) });
  const contexts = [];
  for (const who of ['admin', 'alice', 'bob']) { const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); contexts.push(context); const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); if (who === 'admin') admin = page; else if (who === 'alice') alice = page; else bob = page; }
  async function login(page, who) {
    await page.goto(origin + (who === 'admin' ? '/admin/' : '/'));
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.getByLabel('邮箱', { exact: true }).fill('center-' + who + '@example.test'); await page.getByLabel('密码', { exact: true }).fill(loginPassword);
      const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/sign-in/email');
      await page.getByRole('button', { name: '登录', exact: true }).click(); const response = await pending;
      if (response.status() !== 429 || attempt === 2) { assert.equal(response.status(), 200); break; }
      await waitLimit(response.headers());
    }
    if (who === 'admin') { await page.getByRole('button', { name: '公告管理', exact: true }).click(); await page.getByRole('heading', { name: '公告管理', exact: true }).waitFor(); }
    else await page.getByRole('button', { name: '通知', exact: true }).waitFor();
  }
  async function publish(title, body) {
    await admin.getByRole('button', { name: '新建公告', exact: true }).click(); const dialog = admin.getByRole('dialog');
    await dialog.getByLabel('公告标题', { exact: true }).fill(title); await dialog.getByLabel('公告正文', { exact: true }).fill(body);
    const created = admin.waitForResponse(r => new URL(r.url()).pathname === '/api/admin/announcements' && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: '保存草稿', exact: true }).click(); const response = await created; assert.equal(response.status(), 201);
    const item = (await response.json()).announcement; await dialog.getByText('操作已确认并记录审计。', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '立即发布', exact: true }).click(); await dialog.getByRole('button', { name: '确认发布', exact: true }).click();
    await dialog.getByText('已发布', { exact: true }).waitFor(); await dialog.getByRole('button', { name: '关闭公告' }).click(); return item;
  }
  async function all(page) {
    await page.getByRole('button', { name: '通知', exact: true }).click(); await page.getByLabel('最近通知', { exact: true }).getByRole('button', { name: '查看全部', exact: true }).click();
    await page.getByRole('heading', { name: '通知中心', exact: true }).waitFor();
  }
  async function refresh(page) {
    const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/user/notifications');
    await page.getByRole('button', { name: '刷新通知', exact: true }).click(); assert.equal((await pending).status(), 200);
    await page.locator('[aria-label="通知列表"][aria-busy="false"]').waitFor();
  }
  await login(admin, 'admin');
  const body = '面向所有业务账户\n<img src=x onerror="window.noticeXss=true">\n完整纯文本正文';
  const announcement = await publish('C批广播验收', body);
  await login(alice, 'alice'); await login(bob, 'bob'); await all(alice); await all(bob);
  for (const page of [alice, bob]) await page.getByRole('button', { name: '查看通知 C批广播验收', exact: true }).waitFor();
  assert.equal(await alice.getByRole('button', { name: '查看通知 bob 私人通知' }).count(), 0);
  assert.equal(await bob.getByRole('button', { name: '查看通知 alice 私人通知' }).count(), 0);
  checks.push('real-admin-publish-two-business-accounts-and-original-private-notifications');
  await alice.route('**/api/user/announcements/' + announcement.id + '/read', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
  await alice.getByRole('button', { name: '查看通知 C批广播验收', exact: true }).click(); const detail = alice.getByRole('dialog');
  await detail.getByText(/尚未确认已读结果/).waitFor();
  await detail.getByRole('button', { name: '关闭通知详情' }).click();
  await alice.getByLabel('通知操作恢复').getByRole('button', { name: '重试原已读请求' }).click();
  await alice.getByLabel('通知操作恢复').waitFor({ state: 'detached' });
  await alice.getByRole('button', { name: '查看通知 C批广播验收', exact: true }).click();
  await detail.getByText(body, { exact: true }).waitFor(); await detail.getByText('已读', { exact: true }).waitFor();
  assert.equal(await detail.locator('img').count(), 0); assert.equal(await alice.evaluate(() => window.noticeXss), undefined);
  assert.equal((await owner.query('SELECT count(*)::int n FROM platform_announcement_receipts WHERE announcement_id=$1 AND user_id=$2', [announcement.id, accounts.alice.userId])).rows[0].n, 1);
  assert.equal((await owner.query('SELECT count(*)::int n FROM platform_announcement_receipts WHERE announcement_id=$1 AND user_id=$2', [announcement.id, accounts.bob.userId])).rows[0].n, 0);
  await alice.screenshot({ path: join(output, 'desktop-detail.png'), fullPage: true });
  await detail.getByRole('button', { name: '关闭通知详情' }).click(); checks.push('full-plain-text-detail-before-personal-receipt-no-cross-user-read');
  checks.push('unknown-auto-read-dismissible-with-original-request-recovery');
  const marked = alice.waitForResponse(r => r.url().endsWith('/api/user/notifications/read-all'));
  await alice.getByRole('button', { name: '全部已读', exact: true }).click(); const marking = await marked; assert.equal(marking.status(), 200);
  const allBody = marking.request().postData();
  await alice.getByText('全局未读 0 条', { exact: true }).waitFor();
  const next = await publish('之后发布保持未读', '新的有效公告'); await refresh(alice);
  await alice.getByText('全局未读 1 条', { exact: true }).waitFor();
  const replay = await alice.context().request.post(origin + '/api/user/notifications/read-all', { headers: { origin, 'content-type': 'application/json' }, data: allBody });
  assert.equal(replay.status(), 200); assert.equal((await replay.json()).unreadCount, 1);
  checks.push('all-read-authoritative-count-replay-does-not-read-later-publication');
  const newAccount = await register('center-new@example.test');
  const visible = await fetch(api.target + '/api/user/announcements', { headers: { cookie: newAccount.cookie } }); assert.equal(visible.status, 200);
  assert.ok((await visible.json()).items.some(item => item.referenceId === next.id)); checks.push('new-account-reads-effective-broadcast-without-fanout');
  await alice.route('**/api/user/notifications?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
  await alice.getByRole('button', { name: '刷新通知', exact: true }).click(); await alice.getByText('未读数未知', { exact: true }).waitFor();
  await alice.getByRole('button', { name: '重试通知读取', exact: true }).click(); await alice.getByText('全局未读 1 条', { exact: true }).waitFor();
  checks.push('503-visible-unknown-count-and-recovery-not-fake-empty');
  const request = admin.context().request;
  const governance = await request.get(origin + '/api/admin/users/' + accounts.bob.userId + '/governance'); assert.equal(governance.status(), 200);
  const restrictedAccount = await request.post(origin + '/api/admin/users/' + accounts.bob.userId + '/governance', { headers: { origin }, data: { status: 'suspended', expectedVersion: (await governance.json()).account.version, requestId: randomUUID(), reason: '临时只读验收' } }); assert.equal(restrictedAccount.status(), 200);
  await bob.evaluate(() => window.dispatchEvent(new Event('focus'))); await bob.locator('.account-restriction').waitFor();
  await bob.getByRole('button', { name: '查看通知 C批广播验收', exact: true }).click(); await bob.getByRole('dialog').getByText(body, { exact: true }).waitFor();
  assert.equal((await owner.query('SELECT count(*)::int n FROM platform_announcement_receipts WHERE announcement_id=$1 AND user_id=$2', [announcement.id, accounts.bob.userId])).rows[0].n, 0);
  await bob.getByRole('button', { name: '关闭通知详情' }).click(); assert.equal(await bob.getByRole('button', { name: '全部已读', exact: true }).isDisabled(), true);
  checks.push('real-governance-suspended-can-read-without-writing-receipts');
  await owner.query("UPDATE platform_announcements SET published_at=clock_timestamp()-interval '2 seconds', expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [announcement.id]);
  await refresh(alice); assert.equal(await alice.getByRole('button', { name: '查看通知 C批广播验收', exact: true }).count(), 0);
  await alice.getByLabel('查看已结束公告').check(); await alice.getByRole('button', { name: '查看通知 C批广播验收', exact: true }).waitFor();
  await alice.getByRole('button', { name: '查看通知 C批广播验收', exact: true }).click(); await detail.getByText('已结束，不计未读', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '关闭通知详情' }).click();
  const withdrawn = await request.post(origin + '/api/admin/announcements/' + next.id + '/withdraw', { headers: { origin }, data: { expectedVersion: 2, requestId: randomUUID(), reason: '验收撤回' } }); assert.equal(withdrawn.status(), 200);
  await refresh(alice); assert.equal(await alice.getByRole('button', { name: '查看通知 之后发布保持未读' }).count(), 0);
  const missing = await alice.context().request.get(origin + '/api/user/announcements/' + next.id + '?history=true'); assert.equal(missing.status(), 404);
  checks.push('clock-expiry-history-and-real-withdraw-hidden-from-details-and-count');
  for (const width of [1440, 390, 320]) {
    await alice.setViewportSize({ width, height: 1000 });
    assert.ok(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no page overflow at ' + width);
    await alice.screenshot({ path: join(output, 'list-' + width + '.png'), fullPage: true });
    await alice.getByRole('button', { name: '查看通知 C批广播验收', exact: true }).click(); await detail.getByText('已结束，不计未读', { exact: true }).waitFor();
    const box = await detail.boundingBox(); assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 2, 'dialog centered at ' + width);
    assert.ok(await alice.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no detail overflow at ' + width);
    await alice.screenshot({ path: join(output, 'detail-' + width + '.png'), fullPage: true }); await detail.getByRole('button', { name: '关闭通知详情' }).click();
  }
  checks.push('desktop-390-320-list-and-detail-layout');
  await alice.route('**/api/auth/sign-out', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
  await alice.getByRole('button', { name: '退出登录', exact: true }).click();
  await alice.getByText(/退出未确认，通知已清空/).waitFor();
  await alice.getByRole('button', { name: '查看通知 alice 私人通知', exact: true }).waitFor();
  await alice.getByText('全局未读 0 条', { exact: true }).waitFor();
  checks.push('failed-logout-revalidates-identity-and-recovers-notifications');
  await alice.getByLabel('查看已结束公告').check();
  await alice.getByRole('button', { name: '查看通知 C批广播验收', exact: true }).click();
  await alice.context().request.post(origin + '/api/auth/sign-out', { headers: { origin }, data: {} });
  await alice.evaluate(() => window.dispatchEvent(new Event('focus'))); await alice.getByRole('heading', { name: '登录控制台', exact: true }).waitFor();
  assert.equal(await alice.getByRole('dialog').count(), 0); assert.equal(await alice.getByText(body, { exact: true }).count(), 0);
  checks.push('logout-clears-protected-detail-and-old-session');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: true, checks, pageErrors: errors, authentication: 'real Better Auth', databaseRole: 'restricted LOGIN role', simulatedChecks: ['503 browser response', 'expiry fixture clock'], productionDeployment: false }, null, 2));
  console.log('PASS notification center browser: ' + checks.length + ' groups. Report: ' + join(output, 'report.json'));
} catch (error) {
  await alice?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: false, checks, pageErrors: errors, error: error.message }, null, 2)); throw error;
} finally {
  await browser?.close(); await web?.close(); await adminWeb?.close(); if (app) await new Promise(r => app.close(r)); await pool?.end(); await owner?.end();
  if (container && /^[0-9a-f]{64}$/.test(container)) await exec('docker', ['rm', '-f', container], { windowsHide: true, timeout: 30000 });
  assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(resolve(temp).startsWith(join(resolve(tmpdir()), 'bairui-notifications-browser-')));
  await rm(temp, { recursive: true, force: true });
}
