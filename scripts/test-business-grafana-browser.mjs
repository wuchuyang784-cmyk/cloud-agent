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
import { loadBusinessMonitoringEnv } from '../apps/platform-api/src/admin/business-monitoring-env.mjs';
import { waitForPostgres } from './postgres-ready.mjs';
import { businessDashboard, grafanaExpressions } from '../apps/platform-api/src/admin/grafana-dashboard.mjs';

// Real Grafana + business metrics, but disposable authentication DB/test identities.
// Never read business .env, create business users, or change business platform roles.
const root = fileURLToPath(new URL('../', import.meta.url));
const modulePath = process.env.BAIRUI_PLAYWRIGHT_MODULE;
assert.ok(modulePath, 'Set BAIRUI_PLAYWRIGHT_MODULE to an installed Playwright entrypoint.');
const connector = await loadBusinessMonitoringEnv({ NODE_ENV: 'test', BAIRUI_ADMIN_MONITORING_CONFIG_FILE: join(root, 'output/business-monitoring/connector.json') });
const { Pool, Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const requireAdmin = createRequire(new URL('../apps/admin-console/package.json', import.meta.url));
const vite = await import(pathToFileURL(requireAdmin.resolve('vite')).href);
const { chromium } = await import(pathToFileURL(modulePath).href);
const exec = promisify(execFile), suffix = randomBytes(6).toString('hex');
const name = 'bairui-grafana-browser-' + suffix, label = 'bairui.grafana.acceptance=' + suffix;
const password = randomBytes(24).toString('hex'), loginPassword = randomBytes(20).toString('hex');
const childEnv = { ...process.env, POSTGRES_PASSWORD: password };
for (const key of Object.keys(childEnv)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$)/.test(key)) delete childEnv[key];
const temp = await mkdtemp(join(tmpdir(), 'bairui-grafana-browser-'));
const output = join(root, 'output/playwright/business-grafana', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
let created = false, owner, pool, app, admin, client, browser, page;
const report = { success: false, checks: [], screenshots: [], queriedPanels: [], panelResults: [], failedRequests: [] };
async function configFor(directory) {
  const before = process.cwd();
  try { process.chdir(temp); return (await vite.loadConfigFromFile({ command: 'serve', mode: 'test' }, join(root, directory, 'vite.config.ts'), temp, undefined, undefined, 'native')).config; }
  finally { process.chdir(before); }
}
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); };
try {
  await exec('docker', ['run', '--rm', '-d', '--name', name, '--label', label, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=grafana_check', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.2-pg17-bookworm'], { env: childEnv, windowsHide: true, timeout: 120000 });
  created = true;
  const { stdout } = await exec('docker', ['inspect', name], { windowsHide: true, timeout: 10000 });
  const port = JSON.parse(stdout)[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/grafana_check`;
  await waitForPostgres(() => new Client({ connectionString, connectionTimeoutMillis: 2000 }));
  owner = new Pool({ connectionString });
  for (const migration of (await readdir(join(root, 'packages/db/migrations'))).filter(n => n.endsWith('.sql') && !n.startsWith('033') && !n.startsWith('038')).sort()) {
    await owner.query(await readFile(join(root, 'packages/db/migrations', migration), 'utf8'));
  }
  await owner.query('CREATE ROLE grafana_browser_app NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO grafana_browser_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO grafana_browser_app');
  await owner.query('REVOKE ALL ON platform_role_bindings,platform_admin_audit,platform_infrastructure_sources,platform_infrastructure_snapshots,platform_account_governance,platform_governance_audit,agent_runtime_controls,agent_runtime_control_requests FROM grafana_browser_app');
  await owner.query('GRANT EXECUTE ON FUNCTION platform_admin_read(text,text,text,text,integer,text,text),platform_account_access(text),platform_account_session_allowed(text),platform_governance_accounts(text,text[]),platform_governance_read(text,text,bigint),platform_governance_change(text,text,text,integer,text,uuid) TO grafana_browser_app');
  pool = new Pool({ connectionString, options: '-c role=grafana_browser_app' });
  const adminConfig = await configFor('apps/admin-console');
  admin = await vite.createServer({ ...adminConfig, root: join(root, 'apps/admin-console'), configFile: false, envDir: false,
    cacheDir: join(temp, 'admin-cache'), server: { ...adminConfig.server, port: 0, hmr: false } });
  await admin.listen();
  const clientConfig = await configFor('apps/console-mvp'), apiProxy = { target: 'http://127.0.0.1:1', changeOrigin: true };
  client = await vite.createServer({ ...clientConfig, root: join(root, 'apps/console-mvp'), configFile: false, envDir: false,
    cacheDir: join(temp, 'client-cache'), server: { ...clientConfig.server, port: 0, hmr: false,
      proxy: { '/admin': { target: 'http://127.0.0.1:' + admin.httpServer.address().port }, '/api': apiProxy, '/healthz': apiProxy } } });
  await client.listen();
  const origin = 'http://127.0.0.1:' + client.httpServer.address().port;
  app = createApp({ env: { ...connector, BAIRUI_METRICS_ENABLED: '0', NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), BAIRUI_GRAFANA_PUBLIC_ORIGIN: origin }, store: new PostgresStore({ pool }) });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); apiProxy.target = 'http://127.0.0.1:' + app.address().port;
  for (const email of ['grafana-admin@example.test', 'grafana-user@example.test']) {
    const response = await fetch(apiProxy.target + '/api/auth/sign-up/email', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: loginPassword, name: email.split('@')[0] }) });
    assert.equal(response.status, 200);
    // Business Principal is created on authenticated resolution, not signup itself.
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.equal((await fetch(apiProxy.target + '/api/auth/me', { headers: { cookie } })).status, 200);
  }
  await owner.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) SELECT id,'platform_admin','grafana-browser-check','disposable test' FROM users WHERE email='grafana-admin@example.test'");
  browser = await chromium.launch({ headless: true, ...(process.env.BAIRUI_BROWSER_EXECUTABLE ? { executablePath: process.env.BAIRUI_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  const errors = [], nativeResults = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/admin/grafana/')) return;
    if (response.status() >= 400 && !url.pathname.includes('zh-Hans')) {
      const failure = { path: url.pathname, queryKeys: [...url.searchParams.keys()], method: response.request().method(), status: response.status() };
      report.failedRequests.push(failure); console.log('Native request:', JSON.stringify(failure));
    }
    if (url.pathname.endsWith('/api/ds/query') && response.status() === 200) nativeResults.push(response.json().then(data => {
      for (const query of response.request().postDataJSON()?.queries ?? []) {
        const result = data.results?.[query.refId];
        report.panelResults.push({ panel: grafanaExpressions.indexOf(query.expr) + 1, status: result?.status ?? response.status(), error: Boolean(result?.error),
          frameCount: result?.frames?.length ?? 0, hasSamples: Boolean(result?.frames?.some(frame => frame.data?.values?.some(values => values.length))) });
      }
      for (const result of Object.values(data.results ?? {})) if (result.frames?.some(frame => frame.data?.values?.some(values => values.length))) report.queriedPanels.push(result.status ?? 200);
    }));
  });
  async function login(email) {
    await page.goto(origin + '/admin/'); await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page.getByLabel('密码', { exact: true }).fill(loginPassword);
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/sign-in/email');
    await page.getByRole('button', { name: '登录', exact: true }).click(); assert.equal((await pending).status(), 200);
  }
  check('anonymous Grafana rejected', (await context.request.get(origin + '/api/admin/grafana/api/user')).status() === 401);
  await login('grafana-admin@example.test'); await page.getByRole('heading', { name: '平台概览', exact: true }).waitFor();
  await page.locator('main.content[aria-busy="false"]').waitFor();
  const overview = await (await context.request.get(origin + '/api/admin/monitoring/overview')).json();
  check('current business API and database are real and ready', overview.scope === 'business' && overview.metrics.apiReplicas.value === 1 && overview.metrics.databaseReady.value === 1);
  await page.getByRole('button', { name: '运行监控', exact: true }).click();
  await page.getByText('只读运行监控 · 业务环境', { exact: true }).waitFor();
  const iframe = page.frameLocator('iframe[title="BaiRui 平台运行监控"]');
  await iframe.getByText('业务 API 可采集副本 / 预期 1', { exact: true }).waitFor({ timeout: 45000 });
  const identity = await (await context.request.get(origin + '/api/admin/grafana/api/user')).json();
  const memberships = await (await context.request.get(origin + '/api/admin/grafana/api/user/orgs')).json();
  check('platform administrator is Grafana Viewer, not Grafana admin', memberships.some(org => org.orgId === 1 && org.role === 'Viewer') && identity.isGrafanaAdmin === false);
  for (const panel of businessDashboard().panels) await iframe.getByText(panel.title, { exact: true }).scrollIntoViewIfNeeded();
  const panelsDeadline = Date.now() + 30000;
  while (Date.now() < panelsDeadline && !grafanaExpressions.every((_, index) => report.panelResults.some(result => result.panel === index + 1))) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await Promise.all(nativeResults);
  check('all 17 native panels query successfully', grafanaExpressions.every((_, index) => report.panelResults.some(result => result.panel === index + 1 && result.status === 200 && !result.error)));
  check('host, business and Controller panels contain real samples', [1, 2, 7, 8, 9, 11, 13, 14, 15, 16, 17].every(panel => report.panelResults.some(result => result.panel === panel && result.hasSamples)));
  check('single-series stat cards do not duplicate instant and range values', [1, 2, 8, 15].every(panel => report.panelResults.filter(result => result.panel === panel).every(result => result.frameCount === 1)));
  await page.screenshot({ path: join(output, 'host-controller.png'), scale: 'css' }); report.screenshots.push('host-controller.png');
  await iframe.getByText('业务 API 可采集副本 / 预期 1', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'desktop.png'), scale: 'css' }); report.screenshots.push('desktop.png');
  await page.getByRole('button', { name: '刷新监控', exact: true }).click(); await iframe.getByText('业务数据库就绪', { exact: true }).waitFor();
  check('manual refresh reloads the actual dashboard', await page.locator('iframe').count() === 1);
  const popupPending = page.waitForEvent('popup'); await page.getByRole('link', { name: '独立打开 Grafana' }).click();
  const popup = await popupPending; await popup.getByText('业务数据库就绪', { exact: true }).waitFor({ timeout: 60000 }); await popup.close();
  check('standalone same-session dashboard opens', true);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    check(width + 'px admin has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(output, 'mobile-' + width + '.png'), scale: 'css' }); report.screenshots.push('mobile-' + width + '.png');
  }
  check('arbitrary Grafana proxy target is blocked', (await context.request.get(origin + '/api/admin/grafana/api/datasources/proxy/uid/bairui-prometheus/api/v1/query?query=up')).status() === 404);
  const adminId = (await owner.query("SELECT id FROM users WHERE email='grafana-admin@example.test'")).rows[0].id;
  await owner.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES($1,'suspended',1) ON CONFLICT(user_id) DO UPDATE SET status='suspended',version=platform_account_governance.version+1", [adminId]);
  check('suspension blocks the next native Grafana request', (await context.request.get(origin + '/api/admin/grafana/api/user')).status() === 403);
  await owner.query("UPDATE platform_account_governance SET status='active',version=version+1 WHERE user_id=$1", [adminId]);
  check('restore permits Viewer again without privilege elevation', (await context.request.get(origin + '/api/admin/grafana/api/user')).status() === 200);
  await page.getByRole('button', { name: '退出账号', exact: true }).click(); await page.getByLabel('邮箱', { exact: true }).waitFor();
  check('logout revokes Grafana access', (await context.request.get(origin + '/api/admin/grafana/api/user')).status() === 401);
  await login('grafana-user@example.test'); await page.getByRole('heading', { name: '无管理端访问权限' }).waitFor();
  check('ordinary real account rejected', (await context.request.get(origin + '/api/admin/grafana/api/user')).status() === 403);
  check('no page runtime errors', errors.length === 0);
  check('no unexpected native Grafana request failures', report.failedRequests.length === 0);
  report.success = true; console.log('PASS: real Better Auth/PostgreSQL -> same-origin Viewer Grafana -> business Prometheus; desktop/390/320, native queries, refresh, standalone, suspension, logout, ordinary denial.');
} catch (error) {
  if (page) await page.screenshot({ path: join(output, 'failure.png'), scale: 'css' }).catch(() => {});
  console.error('Grafana request failures:', JSON.stringify(report.failedRequests)); throw error;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await client?.close(); await admin?.close();
  if (app) { await new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }); await app.platform.store?.close?.(); }
  await pool?.end(); await owner?.end();
  if (created) {
    const { stdout } = await exec('docker', ['inspect', name]); const item = JSON.parse(stdout)[0];
    assert.equal(item.Config.Labels['bairui.grafana.acceptance'], suffix);
    await exec('docker', ['rm', '-f', item.Id], { windowsHide: true, timeout: 30000 });
  }
  assert.equal(dirname(resolve(temp)), resolve(tmpdir())); assert.ok(resolve(temp).startsWith(join(resolve(tmpdir()), 'bairui-grafana-browser-')));
  await rm(temp, { recursive: true, force: true });
  console.log('Evidence:', output);
}
