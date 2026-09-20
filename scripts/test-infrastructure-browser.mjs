import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../apps/platform-api/src/app.mjs';
import { PostgresStore } from '../apps/platform-api/src/postgres-store.mjs';
import { waitForPostgres } from './postgres-ready.mjs';
import { collectSnapshot } from './infrastructure-collector.mjs';

// Opt-in browser acceptance, disposable identities and database; never load business .env.
if (!process.env.BAIRUI_PLAYWRIGHT_MODULE) throw new Error('Set BAIRUI_PLAYWRIGHT_MODULE to an installed Playwright entrypoint.');
const root = fileURLToPath(new URL('../', import.meta.url));
const { Pool, Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const requireAdmin = createRequire(new URL('../apps/admin-console/package.json', import.meta.url));
const vite = await import(pathToFileURL(requireAdmin.resolve('vite')).href);
const { chromium } = await import(pathToFileURL(process.env.BAIRUI_PLAYWRIGHT_MODULE).href);
const exec = promisify(execFile);
const name = 'bairui-infra-browser-' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex'), loginPassword = randomBytes(20).toString('hex');
const env = { ...process.env, POSTGRES_PASSWORD: password };
for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$)/.test(key)) delete env[key];
const temp = await mkdtemp(join(tmpdir(), 'bairui-infra-browser-'));
const output = join(root, 'output/playwright/admin-phase-c');
await mkdir(output, { recursive: true });
let created = false, owner, pool, writer, app, admin, browser, page;
try {
  await exec('docker', ['run', '--rm', '-d', '--name', name, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=infra_check', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.2-pg17-bookworm'], { env, windowsHide: true, timeout: 120000 });
  created = true;
  const { stdout } = await exec('docker', ['inspect', name], { windowsHide: true, timeout: 10000 });
  const port = JSON.parse(stdout)[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/infra_check`;
  await waitForPostgres(() => new Client({ connectionString, connectionTimeoutMillis: 2000 }));
  owner = new Pool({ connectionString });
  for (const migration of (await readdir(join(root, 'packages/db/migrations'))).filter(n => n.endsWith('.sql') && !n.startsWith('033')).sort()) {
    await owner.query(await readFile(join(root, 'packages/db/migrations', migration), 'utf8'));
  }
  await owner.query('CREATE ROLE infra_browser_app NOLOGIN NOSUPERUSER NOBYPASSRLS');
  await owner.query('GRANT USAGE ON SCHEMA public TO infra_browser_app');
  await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO infra_browser_app');
  await owner.query('REVOKE ALL ON platform_role_bindings,platform_admin_audit,platform_infrastructure_sources,platform_infrastructure_snapshots FROM infra_browser_app');
  await owner.query('GRANT EXECUTE ON FUNCTION platform_admin_read(text,text,text,text,integer,text,text),platform_infrastructure_read(text) TO infra_browser_app');
  await owner.query('GRANT EXECUTE ON FUNCTION platform_account_access(text),platform_account_session_allowed(text),platform_governance_accounts(text,text[]) TO infra_browser_app');
  await owner.query(`CREATE ROLE infra_browser_writer LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${password}'`);
  await owner.query('GRANT USAGE ON SCHEMA public TO infra_browser_writer');
  await owner.query('GRANT EXECUTE ON FUNCTION platform_infrastructure_report(jsonb) TO infra_browser_writer');
  await owner.query("INSERT INTO platform_infrastructure_sources(source_id,label,login_role) VALUES('development-host','本机开发服务器','infra_browser_writer')");
  const writerUrl = new URL(connectionString); writerUrl.username = 'infra_browser_writer';
  writer = new Pool({ connectionString: writerUrl.href });
  pool = new Pool({ connectionString, options: '-c role=infra_browser_app' });
  const before = cpus(); await sleep(1000);
  const { snapshot } = await collectSnapshot(before, { env: { ...env, BAIRUI_INFRA_SWARM: '1' } });
  assert.equal(snapshot.swarm.status, 'ok', 'requires a local running Swarm manager; no fabricated fallback');
  await writer.query('SELECT platform_infrastructure_report($1)', [JSON.stringify(snapshot)]);
  const previous = process.cwd();
  let config;
  try {
    process.chdir(temp);
    config = (await vite.loadConfigFromFile({ command: 'serve', mode: 'test' }, join(root, 'apps/admin-console/vite.config.ts'), temp, undefined, undefined, 'native')).config;
  } finally { process.chdir(previous); }
  const apiProxy = { target: 'http://127.0.0.1:1', changeOrigin: true };
  admin = await vite.createServer({ ...config, root: join(root, 'apps/admin-console'), configFile: false, envDir: false,
    cacheDir: join(temp, 'admin-cache'), server: { ...config.server, port: 0, hmr: false, proxy: { '/api': apiProxy } } });
  await admin.listen();
  const origin = 'http://127.0.0.1:' + admin.httpServer.address().port;
  app = createApp({ env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: randomBytes(32).toString('hex') }, store: new PostgresStore({ pool }) });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  apiProxy.target = 'http://127.0.0.1:' + app.address().port;
  for (const email of ['infra-admin@example.test', 'infra-ordinary@example.test']) {
    const res = await fetch(apiProxy.target + '/api/auth/sign-up/email', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: loginPassword, name: email }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const identity = await fetch(apiProxy.target + '/api/auth/me', { headers: { cookie } });
    assert.equal(identity.status, 200);
  }
  const manager = (await owner.query("SELECT id FROM users WHERE email='infra-admin@example.test'")).rows[0].id;
  await owner.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES($1,'platform_viewer','browser-check','disposable test')", [manager]);
  browser = await chromium.launch({ headless: true, ...(process.env.BAIRUI_BROWSER_EXECUTABLE ? { executablePath: process.env.BAIRUI_BROWSER_EXECUTABLE } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/admin/');
  await page.getByLabel('邮箱', { exact: true }).fill('infra-admin@example.test');
  await page.getByLabel('密码', { exact: true }).fill(loginPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '用户账号', exact: true }).waitFor();
  await page.locator('main.content[aria-busy="false"]').waitFor();
  const infrastructureResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/infrastructure');
  await page.getByRole('button', { name: '服务器资源', exact: true }).click();
  const response = await infrastructureResponse;
  assert.equal(response.status(), 200, 'infrastructure endpoint status');
  const infrastructure = await response.json();
  assert.equal(infrastructure.items[0]?.status, 'fresh', 'initial sample state: ' + JSON.stringify({
    observedAt: infrastructure.observedAt, status: infrastructure.items[0]?.status,
    sampledAt: infrastructure.items[0]?.sampledAt, receivedAt: infrastructure.items[0]?.receivedAt,
  }));
  await page.getByText('采样正常', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('主机 CPU 使用率').getAttribute('value'), String(snapshot.host.cpuPercent));
  await page.getByRole('heading', { name: '服务调度', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'resources-desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no outer page overflow at ' + width);
    await page.screenshot({ path: join(output, 'resources-mobile-' + width + '.png'), fullPage: true });
  }
  await owner.query("UPDATE platform_infrastructure_snapshots SET received_at=now()-interval '2 minutes'");
  await page.getByRole('button', { name: '刷新服务器资源', exact: true }).click();
  await page.getByText('采样已过期', { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'resources-stale.png'), fullPage: true });
  await owner.query("UPDATE platform_infrastructure_snapshots SET received_at=now(),payload=jsonb_set(payload,'{swarm,status}','\"unavailable\"')");
  await page.getByRole('button', { name: '刷新服务器资源', exact: true }).click();
  await page.getByText('Swarm 采集不可用', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '服务调度', exact: true }).count(), 0);
  await owner.query('DELETE FROM platform_infrastructure_snapshots');
  await page.getByRole('button', { name: '刷新服务器资源', exact: true }).click();
  await page.getByText('等待采集', { exact: true }).first().waitFor();
  assert.equal(await page.getByLabel('主机 CPU 使用率').count(), 0);
  await owner.query('DELETE FROM platform_infrastructure_sources');
  await page.getByRole('button', { name: '刷新服务器资源', exact: true }).click();
  await page.getByText('尚未配置采集源', { exact: true }).waitFor();
  await owner.query('UPDATE platform_role_bindings SET revoked_at=now() WHERE user_id=$1', [manager]);
  await page.getByRole('button', { name: '刷新服务器资源', exact: true }).click();
  await page.getByRole('heading', { name: '无管理端访问权限' }).waitFor();
  assert.equal(await page.getByText('本机开发服务器', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '退出账号', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill('infra-ordinary@example.test');
  await page.getByLabel('密码', { exact: true }).fill(loginPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '无管理端访问权限' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: real collector -> restricted PostgreSQL -> Better Auth -> admin UI; desktop/390/320, stale, unavailable, waiting, empty, revocation and ordinary-user rejection.');
  console.log('Screenshots: output/playwright/admin-phase-c');
} catch (error) {
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await admin?.close();
  if (app) await new Promise(r => app.close(r));
  await writer?.end(); await pool?.end(); await owner?.end();
  if (created) await exec('docker', ['rm', '-f', name], { windowsHide: true, timeout: 30000 });
  assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
  assert.ok(resolve(temp).startsWith(join(resolve(tmpdir()), 'bairui-infra-browser-')));
  await rm(temp, { recursive: true, force: true });
}
