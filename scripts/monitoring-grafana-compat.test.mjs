import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { docker, inspect, localDocker, root } from './preprod.mjs';
import { gatewayConfig } from './preprod-config.mjs';
import { monitoringAssets, monitoringStack, monitorImages, monitorNames } from './monitoring-config.mjs';

// Real current API -> generated Caddy -> Grafana/Prometheus. Authentication is a
// disposable MemoryStore fixture, not proof of a real Better Auth deployment.
const suffix = randomBytes(8).toString('hex'), label = 'bairui.grafana.compat';
const names = Object.fromEntries(['network', 'api', 'gateway', 'grafana', 'prometheus'].map(kind => [kind, 'bairui-grafana-compat-' + kind + '-' + suffix]));
const caddyImage = 'caddy:2.10.2-alpine';
const apiImage = 'bairui/platform-api-preprod:984167c866f5c602';
const directory = await mkdtemp(join(tmpdir(), 'bairui-grafana-compat-'));
const output = join(root, 'output', 'monitoring-single-origin', new Date().toISOString().replace(/[:.]/g, '-'));
const report = { success: false, authentication: 'isolated fixture, not real Better Auth', checks: [] };
const checks = message => { report.checks.push(message); console.log('PASS: ' + message); };
let browser;

async function waitFor(url, status = 200, headers = {}, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(3000) });
      if (response.status === status) return response;
      await response.body?.cancel();
    } catch {}
    await delay(500);
  }
  throw new Error('single_origin_service_timeout');
}
const mount = (source, target) => ['--mount', 'type=bind,source=' + source.replaceAll('\\', '/') + ',target=' + target + ',readonly'];
async function removeOwned(kind, name) {
  const item = await inspect(kind, name);
  if (!item) return;
  assert.equal((kind === 'container' ? item.Config.Labels : item.Labels)[label], suffix, 'temporary_resource_owner_mismatch');
  await docker(kind === 'container' ? ['rm', '-f', item.Id] : [kind, 'rm', item.Id]);
}

try {
  await localDocker();
  await mkdir(output, { recursive: true });
  const linuxRevision = await docker(['run', '--rm', '--pull=never', '--network', 'none', '--label', label + '=' + suffix,
    ...mount(join(root, 'scripts'), '/app/scripts'), ...mount(join(root, 'apps/platform-api/src'), '/app/apps/platform-api/src'),
    apiImage, 'node', '--input-type=module', '-e',
    "import{businessRevision}from'./scripts/business-monitoring-config.mjs';console.log(businessRevision('https://console.example.com'))"]);
  assert.match(linuxRevision, /^[a-f0-9]{16}$/);
  checks('cloud business configuration revision computes inside actual Linux Node runtime');
  for (const publicOrigin of [undefined, 'https://console.example.com']) {
    const path = join(directory, 'validate.Caddyfile');
    await writeFile(path, gatewayConfig({ monitoring: { enabled: true }, publicOrigin }));
    await docker(['run', '--rm', '--pull=never', '--network', 'none', '--label', label + '=' + suffix,
      ...mount(path, '/etc/caddy/Caddyfile'), caddyImage, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  }
  checks('official Caddy validates generated local and public-domain configurations');

  // Fixture changes transport only: the internal authenticated listener and all
  // generated routing remain exactly the deployment generator's output.
  const caddyfile = gatewayConfig({ monitoring: { enabled: true } }).replace('https://localhost {', ':8080 {').replace('  tls internal\n', '');
  await writeFile(join(directory, 'Caddyfile'), caddyfile);
  await writeFile(join(directory, 'control'), 'active');
  await docker(['network', 'create', '--label', label + '=' + suffix, names.network]);
  await docker(['run', '-d', '--pull=never', '--name', names.gateway, '--label', label + '=' + suffix,
    '--network', names.network, '--network-alias', 'bairui-preprod-gateway', '--read-only', '--cap-drop=ALL', '--cap-add=NET_BIND_SERVICE',
    '--tmpfs', '/config', '--tmpfs', '/data', '--tmpfs', '/tmp', '-p', '127.0.0.1::8080',
    ...mount(join(directory, 'Caddyfile'), '/etc/caddy/Caddyfile'),
    ...mount(join(root, 'apps/admin-console/dist'), '/srv/admin'), caddyImage]);
  const gateway = await inspect('container', names.gateway);
  assert.equal(gateway.State.Running, true);
  assert.deepEqual(Object.keys(gateway.HostConfig.PortBindings), ['8080/tcp']);
  const port = gateway.NetworkSettings.Ports['8080/tcp'][0].HostPort;
  const origin = 'http://localhost:' + port;
  const gatewayIp = gateway.NetworkSettings.Networks[names.network].IPAddress;

  const fixture = `
    import {readFile} from 'node:fs/promises';
    import {createApp} from '/app/src/app.mjs';
    import {MemoryStore} from '/app/src/store.mjs';
    const store=new MemoryStore({seed:{users:[
      {id:'viewer',email:'viewer@example.test',organizationId:'org-a',role:'user'},
      {id:'ordinary',email:'ordinary@example.test',organizationId:'org-b',role:'user'}]}});
    store.platformRoles=new Map([['viewer',{role:'platform_viewer',revokedAt:null}]]);
    const app=createApp({store,env:{NODE_ENV:'test',BAIRUI_AUTH_MODE:'better-auth',
      BAIRUI_GRAFANA_UPSTREAM_URL:'http://bairui-preprod-gateway:9494',BAIRUI_GRAFANA_AUTH_MODE:'session',
      BAIRUI_GRAFANA_PUBLIC_ORIGIN:${JSON.stringify(origin)},BAIRUI_MONITORING_SCOPE:'preprod',
      BAIRUI_PROMETHEUS_URL:'http://${monitorNames.prometheus}:9090'},
      auth:{provider:'better-auth',async resolve(req){
        const mode=(await readFile('/fixture/control','utf8')).trim();
        if(mode==='revoked')return null;
        store.accountGovernance=mode==='paused'?new Map([['viewer',{status:'suspended',version:1}]]):new Map();
        const id=req.headers.cookie==='platform=valid'?'viewer':req.headers.cookie==='platform=ordinary'?'ordinary':null;
        const user=id&&store.findUser(id);return user&&{userId:user.id,organizationId:user.organizationId,email:user.email};
      }}});
    app.listen(8080,'0.0.0.0');
  `;
  await writeFile(join(directory, 'api-fixture.mjs'), fixture);
  await docker(['run', '-d', '--pull=never', '--name', names.api, '--label', label + '=' + suffix,
    '--network', names.network, '--network-alias', 'tasks.bairui-preprod_api', '--read-only', '--cap-drop=ALL', '--memory=384m', '--pids-limit=128',
    ...mount(join(root, 'apps/platform-api/src'), '/app/src'), ...mount(directory, '/fixture'), apiImage, 'node', '/fixture/api-fixture.mjs']);

  const assets = monitoringAssets();
  await mkdir(join(directory, 'dashboards'));
  await writeFile(join(directory, 'dashboards/platform.json'), JSON.stringify(assets['dashboard.json']));
  await writeFile(join(directory, 'datasources.json'), JSON.stringify(assets['datasources.json']));
  await writeFile(join(directory, 'dashboards.json'), JSON.stringify(assets['dashboards.json']));
  await writeFile(join(directory, 'prometheus.json'), JSON.stringify({ global: { scrape_interval: '5s' }, scrape_configs: [{ job_name: 'fixture-prometheus', static_configs: [{ targets: ['localhost:9090'] }] }] }));
  await docker(['run', '-d', '--pull=never', '--name', names.prometheus, '--label', label + '=' + suffix,
    '--network', names.network, '--network-alias', monitorNames.prometheus, '--read-only', '--cap-drop=ALL', '--memory=256m',
    '--tmpfs', '/prometheus:uid=65534,gid=65534', ...mount(join(directory, 'prometheus.json'), '/etc/prometheus/prometheus.yml'), monitorImages.prometheus]);
  const environment = monitoringStack({ installation: 'a'.repeat(24), nodeId: 'fixture-node', revision: 'b'.repeat(16),
    monitoring: { enabled: true, gatewayIp }, publicOrigin: origin }).services.grafana.environment;
  // HTTP transport is fixture-only. Every other Grafana setting is generated by
  // the real deployment, including the disabled Grafana alert-rule subsystem.
  environment.GF_SECURITY_COOKIE_SECURE = 'false';
  await writeFile(join(directory, 'grafana-password'), randomBytes(24).toString('hex'), { mode: 0o600 });
  await docker(['run', '-d', '--pull=never', '--name', names.grafana, '--label', label + '=' + suffix,
    '--network', names.network, '--network-alias', 'tasks.' + monitorNames.grafana, '--read-only', '--cap-drop=ALL', '--memory=384m',
    '--tmpfs', '/var/lib/grafana:uid=472,gid=472', '--tmpfs', '/tmp',
    ...mount(join(directory, 'grafana-password'), '/run/secrets/grafana-password'),
    ...mount(join(directory, 'datasources.json'), '/etc/grafana/provisioning/datasources/bairui.yaml'),
    ...mount(join(directory, 'dashboards.json'), '/etc/grafana/provisioning/dashboards/bairui.yaml'),
    ...mount(join(directory, 'dashboards'), '/etc/bairui/dashboards'),
    ...Object.entries(environment).flatMap(([key, value]) => ['--env', key + '=' + value]), monitorImages.grafana]);
  const prefix = origin + '/api/admin/grafana';
  const headers = { cookie: 'platform=valid' };
  await waitFor(prefix + '/api/health', 200, headers);
  for (const [cookie, status] of [['', 401], ['platform=ordinary', 403], ['grafana_session=forged', 401]]) {
    assert.equal((await fetch(prefix + '/api/user', { headers: { cookie, 'x-bairui-monitor-user': 'admin', 'x-bairui-monitor-role': 'Admin' } })).status, status);
  }
  checks('anonymous, ordinary user, forged identity and Grafana cookies cannot bypass platform access');
  const identity = await fetch(prefix + '/api/user', { headers });
  assert.equal(identity.status, 200); assert.equal(identity.headers.get('set-cookie'), null);
  assert.equal((await identity.json()).login, 'bairui:viewer');
  const memberships = await (await fetch(prefix + '/api/user/orgs', { headers })).json();
  assert.equal(memberships[0].role, 'Viewer');
  const dashboard = await (await fetch(prefix + '/api/dashboards/uid/bairui-platform', { headers })).json();
  assert.equal(dashboard.meta.folderUid, 'bairui-platform-folder');
  assert.equal((await fetch(prefix + '/api/folders/' + dashboard.meta.folderUid + '?accesscontrol=true&isLegacyCall=true', { headers })).status, 200);
  checks('actual preprod dashboard provisioning and folder discovery work through the fixed Viewer gateway');
  const html = await (await fetch(prefix + '/d/bairui-platform/bairui-platform?kiosk', { headers })).text();
  assert.match(html, /Grafana/);
  const assetsToCheck = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map(match => new URL(match[1], prefix + '/')).filter(url => url.pathname.startsWith('/api/admin/grafana/public/')).slice(0, 5);
  assert.ok(assetsToCheck.length >= 2, 'native_assets_missing');
  for (const url of assetsToCheck) { assert.equal(url.origin, origin); const response = await fetch(url, { headers }); assert.equal(response.status, 200); await response.body?.cancel(); }
  const body = { from: String(Date.now() - 60000), to: String(Date.now()), queries: [{ refId: 'A', expr: 'sum(up{job="bairui-api"}) or vector(0)', datasource: { type: 'prometheus', uid: 'bairui-prometheus' }, instant: true }] };
  const post = value => ({ method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const query = await fetch(prefix + '/api/ds/query', post(body));
  assert.equal(query.status, 200); assert.equal((await query.json()).results.A.status, 200);
  assert.equal((await fetch(prefix + '/api/ds/query', post({ ...body, queries: [{ ...body.queries[0], expr: 'up' }] }))).status, 422);
  for (const path of ['/login', '/api/admin/users', '/api/datasources/proxy/uid/bairui-prometheus/api/v1/query?query=up']) assert.equal((await fetch(prefix + path, { headers })).status, 404);
  checks('native HTML/static assets and fixed Prometheus queries share one origin; independent login and arbitrary queries denied');

  if (process.env.BAIRUI_PLAYWRIGHT_MODULE) {
    const { chromium } = await import(pathToFileURL(process.env.BAIRUI_PLAYWRIGHT_MODULE).href);
    browser = await chromium.launch({ headless: true, ...(process.env.BAIRUI_BROWSER_EXECUTABLE ? { executablePath: process.env.BAIRUI_BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: 'platform', value: 'valid', url: origin }]);
    const page = await context.newPage();
    const failedNative = [], pageErrors = [], queriedPanels = new Set();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/admin/grafana/')) return;
      if (response.status() >= 400 && !url.pathname.includes('zh-Hans')) failedNative.push({ path: url.pathname, status: response.status() });
      if (url.pathname.endsWith('/api/ds/query') && response.status() === 200) {
        for (const query of response.request().postDataJSON()?.queries ?? []) queriedPanels.add(query.expr);
      }
    });
    await page.goto(origin + '/admin/'); await page.getByRole('button', { name: '运行监控', exact: true }).click();
    const iframe = page.frameLocator('iframe');
    await iframe.getByText('API 可采集副本 / 预期 2', { exact: true }).waitFor({ timeout: 45000 });
    for (const panel of assets['dashboard.json'].panels) await iframe.getByText(panel.title, { exact: true }).scrollIntoViewIfNeeded();
    const queryDeadline = Date.now() + 30000;
    while (queriedPanels.size < assets['dashboard.json'].panels.length && Date.now() < queryDeadline) await delay(100);
    assert.equal(queriedPanels.size, assets['dashboard.json'].panels.length, 'all preprod panels must complete native queries');
    assert.deepEqual(failedNative, [], 'native Grafana request failures'); assert.deepEqual(pageErrors, []);
    assert.equal(await iframe.getByText('Unexpected alert rules response.', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: '独立打开 Grafana' }).count(), 0);
    const refreshed = page.waitForResponse(response => response.url() === prefix + '/api/health');
    await page.getByRole('button', { name: '刷新监控', exact: true }).click(); await refreshed;
    await iframe.getByText('API 可采集副本 / 预期 2', { exact: true }).waitFor();
    await iframe.getByText('API 可采集副本 / 预期 2', { exact: true }).scrollIntoViewIfNeeded();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(output, 'admin-' + width + '.png') });
    }
    assert.equal(context.pages().length, 1);
    checks('browser admin embeds all 12 queried Grafana panels without native request errors, retry rechecks health, desktop/mobile keep one tab and one origin');
  }
  await writeFile(join(directory, 'control'), 'paused');
  assert.equal((await fetch(prefix + '/api/user', { headers })).status, 403);
  await writeFile(join(directory, 'control'), 'revoked');
  assert.equal((await fetch(prefix + '/api/user', { headers })).status, 401);
  await writeFile(join(directory, 'control'), 'active');
  await docker(['stop', '--timeout', '5', names.grafana]);
  assert.equal((await fetch(prefix + '/api/user', { headers })).status, 503);
  assert.equal((await fetch(origin + '/api/admin/me', { headers })).status, 200);
  checks('suspension and revoked fixture session deny next request; Grafana failure leaves account management available');
  report.success = true;
} finally {
  await browser?.close();
  for (const name of [names.grafana, names.prometheus, names.api, names.gateway]) await removeOwned('container', name);
  await removeOwned('network', names.network);
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), 'bairui-grafana-compat-')));
  await rm(directory, { recursive: true, force: true });
  report.cleaned = true;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
