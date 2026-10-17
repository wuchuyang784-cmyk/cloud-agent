import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../apps/platform-api/src/app.mjs';
import { PostgresStore } from '../apps/platform-api/src/postgres-store.mjs';
import { waitForPostgres } from './postgres-ready.mjs';
import { publisherTick } from '../apps/platform-api/src/announcements/publisher-store.mjs';

// Explicit installed browser dependency, disposable DB/identities/ports. No business .env or Swarm.
if (!process.env.BAIRUI_PLAYWRIGHT_MODULE) throw new Error('Set BAIRUI_PLAYWRIGHT_MODULE to an installed Playwright entrypoint.');
const root = fileURLToPath(new URL('../', import.meta.url));
const { Pool, Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const requireAdmin = createRequire(new URL('../apps/admin-console/package.json', import.meta.url));
const vite = await import(pathToFileURL(requireAdmin.resolve('vite')).href);
const react = (await import(pathToFileURL(requireAdmin.resolve('@vitejs/plugin-react')).href)).default;
const { chromium } = await import(pathToFileURL(process.env.BAIRUI_PLAYWRIGHT_MODULE).href);
const exec = promisify(execFile), name = 'bairui-announcements-browser-' + randomBytes(8).toString('hex');
const password = randomBytes(24).toString('hex'), loginPassword = randomBytes(24).toString('hex');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|PG)/.test(key)) delete env[key];
env.POSTGRES_PASSWORD = password;
const temp = await mkdtemp(join(tmpdir(), 'bairui-announcements-browser-'));
const output = join(root, 'output/playwright/announcements-d', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
let container, owner, pool, publisherPool, app, web, browser, page;
const checks = [], errors = [];
try {
  const result = await exec('docker', ['run', '--rm', '-d', '--name', name, '--label', 'bairui.test=announcements-browser', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=announcements_browser', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.2-pg17-bookworm'], { env, windowsHide: true, timeout: 120000 });
  container = result.stdout.trim(); assert.match(container, /^[0-9a-f]{64}$/);
  const info = JSON.parse((await exec('docker', ['inspect', container], { windowsHide: true })).stdout)[0];
  const connectionString = 'postgresql://postgres:' + password + '@127.0.0.1:' + info.NetworkSettings.Ports['5432/tcp'][0].HostPort + '/announcements_browser';
  await waitForPostgres(() => new Client({ connectionString, connectionTimeoutMillis: 2000 }));
  owner = new Pool({ connectionString });
  for (const file of (await readdir(join(root, 'packages/db/migrations'))).filter(n => n.endsWith('.sql') && !['033','035','038','039','040'].includes(n.slice(0,3))).sort()) await owner.query(await readFile(join(root, 'packages/db/migrations', file), 'utf8'));
  await owner.query('CREATE ROLE announcement_browser_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await owner.query('GRANT USAGE ON SCHEMA public TO announcement_browser_app');
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO announcement_browser_app');
  await owner.query('REVOKE ALL ON platform_role_bindings,platform_admin_audit,platform_account_governance,platform_governance_audit,platform_announcements,platform_announcement_receipts,platform_announcement_audit,platform_announcement_requests FROM announcement_browser_app');
  await owner.query('GRANT EXECUTE ON FUNCTION platform_admin_read(text,text,text,text,integer,text,text),platform_account_access(text),platform_account_session_allowed(text),platform_governance_accounts(text,text[]),platform_announcement_change(text,jsonb),platform_announcement_read(text,jsonb) TO announcement_browser_app');
  await owner.query('REVOKE ALL ON platform_notification_center_requests FROM announcement_browser_app');
  const publisherPassword = randomBytes(24).toString('hex');
  await owner.query("CREATE ROLE announcement_browser_publisher LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '" + publisherPassword + "'");
  await owner.query('GRANT USAGE ON SCHEMA public TO announcement_browser_publisher');
  await owner.query('GRANT EXECUTE ON FUNCTION platform_announcement_publisher_tick(integer),platform_announcement_publisher_status() TO announcement_browser_publisher');
  const publisherURL = new URL(connectionString); publisherURL.username = 'announcement_browser_publisher'; publisherURL.password = publisherPassword;
  publisherPool = new Pool({ connectionString: publisherURL.href });
  pool = new Pool({ connectionString, options: '-c role=announcement_browser_app' });
  const api = { target: 'http://127.0.0.1:1' };
  web = await vite.createServer({ root: join(root, 'apps/admin-console'), base: '/admin/', configFile: false, envDir: false, plugins: [react()], cacheDir: join(temp, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, proxy: { '/api': api } } });
  await web.listen();
  const origin = 'http://127.0.0.1:' + web.httpServer.address().port;
  app = createApp({ env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: randomBytes(32).toString('hex') }, store: new PostgresStore({ pool }) });
  await new Promise(r => app.listen(0, '127.0.0.1', r)); api.target = 'http://127.0.0.1:' + app.address().port;
  async function respectRateLimit(headers) {
    const seconds = Number(headers['retry-after'] ?? headers.get?.('retry-after'));
    assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 60, 'bounded Retry-After required');
    console.log('Respecting real authentication Retry-After: ' + seconds + ' seconds.');
    await new Promise(r => setTimeout(r, Math.min(seconds + 1, 60) * 1000));
  }
  for (const email of ['notice-admin@example.test', 'notice-second@example.test', 'notice-viewer@example.test', 'notice-user@example.test']) {
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(api.target + '/api/auth/sign-up/email', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, name: email.split('@')[0], password: loginPassword }) });
      if (response.status !== 429 || attempt === 2) break;
      await response.text(); await respectRateLimit(response.headers);
    }
    assert.equal(response.status, 200, 'temporary registration');
    const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
    assert.equal((await fetch(api.target + '/api/auth/me', { headers: { cookie } })).status, 200);
  }
  await owner.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) SELECT id,CASE WHEN email='notice-viewer@example.test' THEN 'platform_viewer' ELSE 'platform_admin' END,'browser','disposable' FROM users WHERE email<>'notice-user@example.test'");
  browser = await chromium.launch({ headless: true, ...(process.env.BAIRUI_BROWSER_EXECUTABLE ? { executablePath: process.env.BAIRUI_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); page = await context.newPage();
  const viewerContext = await browser.newContext(), userContext = await browser.newContext(), secondContext = await browser.newContext();
  const viewer = await viewerContext.newPage(), user = await userContext.newPage(), second = await secondContext.newPage();
  for (const p of [page, viewer, user, second]) p.on('pageerror', error => errors.push(error.message));
  async function login(p, email, denied = false) {
    await p.goto(origin + '/admin/'); await p.getByLabel('邮箱', { exact: true }).fill(email); await p.getByLabel('密码', { exact: true }).fill(loginPassword);
    for (let attempt = 0; attempt < 3; attempt++) {
      // Rejection remounts the form after the loading phase; re-enter both fields, never relax auth limits.
      await p.getByLabel('邮箱', { exact: true }).fill(email);
      await p.getByLabel('密码', { exact: true }).fill(loginPassword);
      assert.equal(await p.locator('form.login-form').evaluate(form => form.checkValidity()), true);
      const pending = p.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/sign-in/email');
      await p.getByRole('button', { name: '登录', exact: true }).click(); const result = await pending;
      if (result.status() !== 429 || attempt === 2) { assert.equal(result.status(), 200, 'real sign in'); break; }
      await respectRateLimit(result.headers());
    }
    if (denied) { await p.getByRole('heading', { name: '无管理端访问权限' }).waitFor(); return; }
    await p.getByRole('button', { name: '公告管理', exact: true }).click();
    await p.getByRole('heading', { name: '公告管理', exact: true }).waitFor();
    await p.getByRole('button', { name: '刷新公告列表' }).waitFor();
  }
  const dialog = page.getByRole('dialog');
  async function save(p) {
    const response = p.waitForResponse(r => r.url().includes('/api/admin/announcements') && ['POST','PATCH'].includes(r.request().method()));
    await p.getByRole('button', { name: '保存草稿', exact: true }).click();
    const result = await response; assert.ok([200,201].includes(result.status()));
    await p.getByRole('dialog').getByText('操作已确认并记录审计。', { exact: true }).waitFor();
    return (await result.json()).announcement;
  }
  await login(page, 'notice-admin@example.test');
  // D: real UI saves future Shanghai schedule, explicitly cancels/reconfirms, then restricted machine publishes.
  await page.getByRole('button', { name: '新建公告', exact: true }).click();
  await dialog.getByLabel('公告标题', { exact: true }).fill('定时发布验收'); await dialog.getByLabel('公告正文', { exact: true }).fill('定时公告正文');
  const scheduledDraft = await save(page);
  await dialog.getByRole('button', { name: '定时发布', exact: true }).click();
  await dialog.getByLabel('计划发布时间', { exact: true }).fill('2099-01-01T10:30');
  let pendingSchedule = page.waitForResponse(r => r.url().endsWith('/publish') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: '确认定时', exact: true }).click();
  const scheduledResult = await pendingSchedule; assert.equal(scheduledResult.status(), 200);
  assert.equal((await scheduledResult.json()).announcement.scheduledAt, '2099-01-01T02:30:00+00:00');
  await dialog.getByText(/定时计划已保存/).waitFor();
  await dialog.getByRole('button', { name: '取消定时', exact: true }).click(); await dialog.getByRole('button', { name: '确认取消定时', exact: true }).click();
  await dialog.getByText(/定时已取消/).waitFor();
  await dialog.getByRole('button', { name: '定时发布', exact: true }).click(); await dialog.getByLabel('计划发布时间', { exact: true }).fill('2099-01-01T10:30');
  pendingSchedule = page.waitForResponse(r => r.url().endsWith('/publish') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: '确认定时', exact: true }).click(); assert.equal((await pendingSchedule).status(), 200);
  await dialog.getByText(/定时计划已保存/).waitFor();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({ path: join(output, 'schedule-' + width + '.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole('button', { name: '关闭公告' }).click();
  await owner.query("UPDATE platform_announcements SET scheduled_at=clock_timestamp()-interval '10 seconds' WHERE id=$1", [scheduledDraft.id]);
  assert.equal((await publisherTick({ pool: publisherPool })).published, 1);
  await page.getByRole('button', { name: '刷新公告列表' }).click(); await page.getByRole('button', { name: '查看公告 定时发布验收', exact: true }).click();
  await dialog.getByText('已发布', { exact: true }).waitFor(); await dialog.locator('.announcement-audit li').filter({ hasText: '系统发布器' }).waitFor();
  assert.equal((await owner.query("SELECT count(*)::int n FROM platform_announcement_audit WHERE announcement_id=$1 AND action='published' AND executor_type='system'", [scheduledDraft.id])).rows[0].n, 1);
  await dialog.getByRole('button', { name: '关闭公告' }).click(); checks.push('D-shanghai-schedule-cancel-reconfirm-real-publisher-system-audit-responsive');
  await page.getByRole('button', { name: '新建公告', exact: true }).click();
  const title = '平台公告验收 ' + randomBytes(4).toString('hex');
  const body = '维护说明\n<img src=x onerror="window.announcementXss=true">\n第二段说明';
  await dialog.getByLabel('公告标题', { exact: true }).fill(title); await dialog.getByLabel('公告正文', { exact: true }).fill(body);
  await page.route('**/api/admin/announcements', async route => {
    if (route.request().method() === 'POST') { await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_announcement_time' } }) }); }
    else await route.continue();
  }, { times: 1 });
  await dialog.getByRole('button', { name: '保存草稿', exact: true }).click();
  await dialog.getByText('操作被拒绝，请核对内容或重新读取后再提交。', { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('公告标题', { exact: true }).isEnabled(), true);
  await dialog.getByLabel('公告有效期', { exact: true }).selectOption('forever');
  let announcement = await save(page); assert.equal(announcement.expiresAt, null);
  await dialog.getByLabel('公告有效期', { exact: true }).selectOption('default');
  announcement = await save(page); assert.equal(announcement.expiryDays, 30);
  await dialog.getByRole('button', { name: '预览公告', exact: true }).click();
  await dialog.getByLabel('公告预览', { exact: true }).getByText(body, { exact: true }).waitFor();
  assert.equal(await dialog.locator('img').count(), 0); assert.equal(await page.evaluate(() => window.announcementXss), undefined);
  await dialog.getByRole('button', { name: '立即发布', exact: true }).click(); await dialog.getByRole('button', { name: '确认发布', exact: true }).click();
  await dialog.getByText('已发布', { exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: '返回编辑', exact: true }).count(), 0);
  await dialog.locator('.announcement-audit li').filter({ hasText: '发布公告' }).waitFor();
  assert.equal((await owner.query("SELECT count(*)::int n FROM platform_announcement_audit WHERE announcement_id=$1 AND action='published'", [announcement.id])).rows[0].n, 1);
  await page.screenshot({ path: join(output, 'desktop-published.png'), fullPage: true }); checks.push('real-auth-save-preview-publish-audit-xss-expiry-reset');
  await dialog.getByRole('button', { name: '关闭公告' }).click();
  await page.route('**/api/admin/announcements/' + announcement.id, async route => { await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }, { times: 1 });
  await page.getByRole('button', { name: '查看公告 ' + title, exact: true }).click();
  await page.getByRole('alert').getByText('公告详情读取失败，请重新选择。', { exact: true }).waitFor();
  checks.push('rejected-create-editable-and-detail-failure-visible');
  await page.getByLabel('搜索公告标题').fill(title.slice(0, 6)); await page.getByRole('button', { name: '搜索公告', exact: true }).click();
  await page.getByRole('button', { name: '查看公告 ' + title, exact: true }).waitFor();
  await login(viewer, 'notice-viewer@example.test'); assert.equal(await viewer.getByRole('button', { name: '新建公告', exact: true }).count(), 0);
  await viewer.getByRole('button', { name: '查看公告 ' + title, exact: true }).click();
  await viewer.getByRole('dialog').getByText('已发布', { exact: true }).waitFor();
  assert.equal(await viewer.getByRole('button', { name: '撤回公告', exact: true }).count(), 0);
  await login(user, 'notice-user@example.test', true); checks.push('server-title-search-viewer-readonly-ordinary-denied');
  await page.getByRole('button', { name: '新建公告', exact: true }).click();
  await dialog.getByLabel('公告标题', { exact: true }).fill('并发编辑验收'); await dialog.getByLabel('公告正文', { exact: true }).fill('初始正文');
  const concurrent = await save(page);
  await login(second, 'notice-second@example.test'); await second.getByRole('button', { name: '查看公告 并发编辑验收', exact: true }).click();
  await second.getByLabel('公告标题', { exact: true }).fill('第二管理员更新'); await save(second);
  await page.bringToFront(); await dialog.getByLabel('公告正文', { exact: true }).fill('迟到覆盖应拒绝');
  assert.equal(await dialog.getByRole('button', { name: '复制为新草稿', exact: true }).isDisabled(), true);
  const conflict = page.waitForResponse(r => r.url().endsWith('/api/admin/announcements/' + concurrent.id) && r.request().method() === 'PATCH');
  await dialog.getByRole('button', { name: '保存草稿', exact: true }).click(); assert.equal((await conflict).status(), 409);
  await dialog.getByText(/公告已变更或请求冲突/).waitFor();
  assert.equal((await owner.query('SELECT title FROM platform_announcements WHERE id=$1', [concurrent.id])).rows[0].title, '第二管理员更新');
  await dialog.getByRole('button', { name: '重新读取最新版本（放弃本地编辑）' }).click();
  await dialog.getByLabel('公告标题', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await dialog.getByLabel('公告标题', { exact: true }).inputValue(), '第二管理员更新');
  await dialog.getByRole('button', { name: '关闭公告' }).click(); checks.push('two-admin-conflict-no-lost-update');
  await page.getByRole('button', { name: '查看公告 ' + title, exact: true }).click();
  await dialog.getByRole('button', { name: '撤回公告', exact: true }).click(); await dialog.getByLabel('撤回原因', { exact: true }).fill('测试公告结束');
  await dialog.getByRole('button', { name: '确认撤回', exact: true }).click(); await dialog.getByText('已撤回', { exact: true }).waitFor();
  await dialog.locator('.announcement-audit li').filter({ hasText: '撤回公告' }).waitFor(); checks.push('withdraw-with-reason-and-durable-audit');
  await dialog.getByRole('button', { name: '关闭公告' }).click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('.table-scroll').evaluate(table => { table.scrollLeft = 0; });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no page overflow at ' + width);
    await page.screenshot({ path: join(output, 'list-' + width + '.png'), fullPage: true });
    await page.getByRole('button', { name: '查看公告 ' + title, exact: true }).click();
    await dialog.getByText('已撤回', { exact: true }).waitFor();
    await dialog.locator('.announcement-audit li').filter({ hasText: '撤回公告' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no dialog overflow at ' + width);
    await page.screenshot({ path: join(output, 'detail-' + width + '.png'), fullPage: true });
    await dialog.getByRole('button', { name: '关闭公告' }).click();
  }
  checks.push('390-320-responsive-list-editor');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '查看公告 ' + title, exact: true }).click(); await dialog.getByText('已撤回', { exact: true }).waitFor();
  await owner.query("UPDATE platform_role_bindings SET revoked_at=now() WHERE user_id=(SELECT id FROM users WHERE email='notice-admin@example.test')");
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.getByRole('heading', { name: '无管理端访问权限' }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0); checks.push('revocation-clears-protected-editor');
  assert.equal((await viewerContext.request.post(origin + '/api/auth/sign-out', { headers: { origin }, data: {} })).status(), 200);
  await viewer.evaluate(() => window.dispatchEvent(new Event('focus'))); await viewer.getByLabel('邮箱', { exact: true }).waitFor();
  assert.equal(await viewer.getByRole('dialog').count(), 0); checks.push('logout-clears-editor-and-old-session');
  assert.deepEqual(errors, []); await writeFile(join(output, 'report.json'), JSON.stringify({ passed: true, checks, pageErrors: errors, authentication: 'real Better Auth', databaseRole: 'restricted disposable PostgreSQL', productionDeployment: false }, null, 2));
  console.log('PASS announcements browser: ' + checks.length + ' groups. Report: ' + join(output, 'report.json'));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: false, checks, pageErrors: errors, error: error.message }, null, 2));
  throw error;
} finally {
  await browser?.close(); await web?.close(); if (app) await new Promise(r => app.close(r)); await pool?.end(); await publisherPool?.end(); await owner?.end();
  if (container && /^[0-9a-f]{64}$/.test(container)) await exec('docker', ['rm', '-f', container], { windowsHide: true, timeout: 30000 });
  assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(resolve(temp).startsWith(join(resolve(tmpdir()), 'bairui-announcements-browser-')));
  await rm(temp, { recursive: true, force: true });
}
