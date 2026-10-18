import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const names = Object.fromEntries(['network', 'api', 'gateway', 'grafana', 'prometheus', 'volume'].map(kind => [kind, 'bairui-grafana-compat-' + kind.toLowerCase() + '-' + suffix]));
const caddyImage = 'caddy:2.10.2-alpine';
const apiImage = 'bairui/platform-api-preprod:984167c866f5c602';
const directory = await mkdtemp(join(tmpdir(), 'bairui-grafana-compat-'));
const output = join(root, 'output', 'monitoring-single-origin', new Date().toISOString().replace(/[:.]/g, '-'));
const report = { success: false, authentication: 'isolated fixture, not real Better Auth', checks: [] };
const checks = message => { report.checks.push(message); console.log('PASS: ' + message); };
let browser, browserPage;

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
  await docker(kind === 'container' ? ['rm', '-f', item.Id] : [kind, 'rm', kind === 'volume' ? item.Name : item.Id]);
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
  const oldDashboard = { ...assets['dashboard.json'], version: 1 };
  const oldProviders = structuredClone(assets['dashboards.json']);
  oldProviders.providers[0].folder = 'BaiRui'; delete oldProviders.providers[0].folderUid;
  await mkdir(join(directory, 'dashboards'));
  await writeFile(join(directory, 'dashboards/platform.json'), JSON.stringify(oldDashboard));
  await writeFile(join(directory, 'datasources.json'), JSON.stringify(assets['datasources.json']));
  await writeFile(join(directory, 'dashboards.json'), JSON.stringify(oldProviders));
  await writeFile(join(directory, 'prometheus.json'), JSON.stringify({ global: { scrape_interval: '5s' }, scrape_configs: [{ job_name: 'fixture-prometheus', static_configs: [{ targets: ['localhost:9090'] }] }] }));
  await docker(['run', '-d', '--pull=never', '--name', names.prometheus, '--label', label + '=' + suffix,
    '--network', names.network, '--network-alias', monitorNames.prometheus, '--read-only', '--cap-drop=ALL', '--memory=256m',
    '--tmpfs', '/prometheus:uid=65534,gid=65534', ...mount(join(directory, 'prometheus.json'), '/etc/prometheus/prometheus.yml'), monitorImages.prometheus]);
  const environment = monitoringStack({ installation: 'a'.repeat(24), nodeId: 'fixture-node', revision: 'b'.repeat(16),
    monitoring: { enabled: true, gatewayIp }, publicOrigin: origin }).services.grafana.environment;
  // HTTP transport is fixture-only. Every other Grafana setting is generated by
  // the real deployment, including the disabled Grafana alert-rule subsystem.
  environment.GF_SECURITY_COOKIE_SECURE = 'false';
  // The random fixture secret lives in a private host temp directory; container uid472 must read its exact file mount on Linux.
  await writeFile(join(directory, 'grafana-password'), randomBytes(24).toString('hex'), { mode: 0o644 });
  await docker(['volume', 'create', '--label', label + '=' + suffix, names.volume]);
  const volumeBefore = await inspect('volume', names.volume);
  await docker(['run', '--rm', '--pull=never', '--network', 'none', '--user', '0:0', '--read-only', '--cap-drop=ALL', '--cap-add=CHOWN',
    '--security-opt=no-new-privileges:true', '--label', label + '=' + suffix, '--mount', 'type=volume,source=' + names.volume + ',target=/data',
    apiImage, 'node', '--input-type=module', '-e', "import{chown}from'node:fs/promises';await chown('/data',472,472)"]);
  const startGrafana = () => docker(['run', '-d', '--pull=never', '--name', names.grafana, '--label', label + '=' + suffix,
    '--network', names.network, '--network-alias', 'tasks.' + monitorNames.grafana, '--read-only', '--cap-drop=ALL', '--memory=384m',
    '--mount', 'type=volume,source=' + names.volume + ',target=/var/lib/grafana', '--tmpfs', '/tmp',
    ...mount(join(directory, 'grafana-password'), '/run/secrets/grafana-password'),
    ...mount(join(directory, 'datasources.json'), '/etc/grafana/provisioning/datasources/bairui.yaml'),
    ...mount(join(directory, 'dashboards.json'), '/etc/grafana/provisioning/dashboards/bairui.yaml'),
    ...mount(join(directory, 'dashboards'), '/etc/bairui/dashboards'),
    ...Object.entries(environment).flatMap(([key, value]) => ['--env', key + '=' + value]), monitorImages.grafana]);
  const prefix = origin + '/api/admin/grafana';
  const headers = { cookie: 'platform=valid' };
  const document = async () => {
    const response = await waitFor(prefix + '/api/dashboards/uid/bairui-platform', 200, headers);
    return response.json();
  };
  await startGrafana();
  await waitFor(prefix + '/api/health', 200, headers);
  const old = await document();
  assert.equal(old.dashboard.uid, 'bairui-platform'); assert.notEqual(old.meta.folderUid, 'bairui-platform-folder');
  assert.ok(old.meta.folderUid, 'old randomly identified folder must exist');
  const oldId = old.dashboard.id, oldFolderUid = old.meta.folderUid;
  checks('legacy version1 dashboard is created in the old random folder on an owned persistent Grafana volume');

  await docker(['stop', '--timeout', '15', names.grafana]);
  const backup = join(output, 'before-upgrade'); await mkdir(backup, { recursive: true });
  await writeFile(join(backup, 'dashboard.json'), JSON.stringify(oldDashboard));
  await writeFile(join(backup, 'dashboards.json'), JSON.stringify(oldProviders));
  const backupArgs = ['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop=ALL', '--cap-add=DAC_OVERRIDE', '--cap-add=CHOWN',
    '--security-opt=no-new-privileges:true', '--memory=128m', '--pids-limit=32', '--label', label + '=' + suffix,
    '--mount', 'type=volume,source=' + names.volume + ',target=/data,readonly'];
  await docker([...backupArgs, '--mount', 'type=bind,source=' + backup.replaceAll('\\', '/') + ',target=/backup', apiImage,
    'node', '--input-type=module', '-e', "import{execFileSync}from'node:child_process';import{chownSync}from'node:fs';process.umask(0o077);execFileSync('tar',['-czf','/backup/grafana-data.tar.gz','-C','/data','.']);chownSync('/backup/grafana-data.tar.gz'," + (process.getuid?.() ?? 0) + ',' + (process.getgid?.() ?? 0) + ')']);
  const archive = await readFile(join(backup, 'grafana-data.tar.gz'));
  assert.ok(archive.length > 0);
  const archiveList = await docker([...backupArgs, ...mount(backup, '/backup'), apiImage, 'tar', '-tzf', '/backup/grafana-data.tar.gz']);
  assert.match(archiveList, /(?:^|\/)grafana\.db(?:\n|$)/);
  report.upgrade = { volume: names.volume, createdAt: volumeBefore.CreatedAt, dashboardId: oldId, oldFolderUid,
    backup: { path: join(backup, 'grafana-data.tar.gz'), sha256: createHash('sha256').update(archive).digest('hex'), verifiedArchive: true } };
  checks('stopped legacy Grafana data and provisioning files backed up before upgrading, archive readable and checksummed');
  await removeOwned('container', names.grafana);

  await writeFile(join(directory, 'dashboards.json'), JSON.stringify(assets['dashboards.json']));
  await startGrafana(); await waitFor(prefix + '/api/health', 200, headers);
  await waitFor(prefix + '/api/folders/bairui-platform-folder?accesscontrol=true&isLegacyCall=true', 200, headers);
  assert.equal((await document()).meta.folderUid, oldFolderUid, 'changing provider alone must reproduce unchanged dashboard checksum behavior');
  checks('same persistent volume plus provider-only restart reproduces the unchanged-checksum old-folder bug');
  await docker(['stop', '--timeout', '15', names.grafana]); await removeOwned('container', names.grafana);

  await writeFile(join(directory, 'dashboards/platform.json'), JSON.stringify(assets['dashboard.json']));
  // M1 did not exist in the legacy installation. Provision it for the first
  // time only after the fixed provider is installed, as in an actual upgrade.
  await writeFile(join(directory, 'dashboards/host.json'), JSON.stringify(assets['dashboard-host.json']));
  await startGrafana(); await waitFor(prefix + '/api/health', 200, headers);
  const upgraded = await document();
  assert.equal(upgraded.meta.folderUid, 'bairui-platform-folder', 'changed dashboard bytes must migrate an already provisioned dashboard');
  assert.equal(upgraded.dashboard.uid, old.dashboard.uid); assert.equal(upgraded.dashboard.id, oldId);
  const hostDocument = await (await waitFor(prefix + '/api/dashboards/uid/bairui-host', 200, headers)).json();
  assert.equal(hostDocument.meta.folderUid, 'bairui-platform-folder', 'new M1 dashboard must belong to the fixed folder');
  const volumeAfter = await inspect('volume', names.volume);
  assert.equal(volumeAfter.Name, volumeBefore.Name); assert.equal(volumeAfter.CreatedAt, volumeBefore.CreatedAt);
  const folders = await (await fetch(prefix + '/api/search?type=dash-folder', { headers })).json();
  assert.ok(folders.some(folder => folder.uid === oldFolderUid), 'old folder must not be deleted');
  report.upgrade.folderUid = upgraded.meta.folderUid; report.upgrade.sameVolume = true; report.upgrade.sameDashboard = true;
  checks('version2 upgrade migrates the same dashboard ID/UID into the fixed folder while retaining volume and old folder');
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
    browserPage = page;
    const failedNative = [], pageErrors = [], failedQueries = [], pendingQueries = new Set(), queriedPanels = new Set();
    const platformExpressions = assets['dashboard.json'].panels.flatMap(panel => panel.targets.map(target => target.expr));
    const hostExpressions = assets['dashboard-host.json'].panels.flatMap(panel => panel.targets.map(target => target.expr));
    const covered = expected => expected.filter(expr => queriedPanels.has(expr));
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/admin/grafana/')) return;
      if (response.status() >= 400 && !url.pathname.includes('zh-Hans')) failedNative.push({ path: url.pathname, status: response.status() });
      if (url.pathname.endsWith('/api/ds/query') && response.status() === 200) {
        const work = (async () => {
          const data = await response.json();
          for (const query of response.request().postDataJSON()?.queries ?? []) {
            const result = data.results?.[query.refId];
            if (result?.status === 200 && !result.error) queriedPanels.add(query.expr);
            else failedQueries.push({ refId: query.refId, status: result?.status ?? null });
          }
        })().catch(() => failedQueries.push({ invalidResponse: true }));
        pendingQueries.add(work); void work.finally(() => pendingQueries.delete(work));
      }
    });
    await page.goto(origin + '/admin/'); await page.getByRole('button', { name: '运行监控', exact: true }).click();
    const iframe = page.frameLocator('iframe');
    await iframe.getByText('API 可采集副本 / 预期 2', { exact: true }).waitFor({ timeout: 45000 });
    for (const panel of assets['dashboard.json'].panels) await iframe.getByText(panel.title, { exact: true }).scrollIntoViewIfNeeded();
    const queryDeadline = Date.now() + 30000;
    while (covered(platformExpressions).length < platformExpressions.length && Date.now() < queryDeadline) await delay(100);
    await Promise.all([...pendingQueries]);
    assert.deepEqual(covered(platformExpressions).sort(), [...platformExpressions].sort(), 'all preprod expressions must complete native queries');
    assert.deepEqual(failedQueries, [], 'per-panel query failures even when outer HTTP status is 200');
    assert.deepEqual(failedNative, [], 'native Grafana request failures'); assert.deepEqual(pageErrors, []);
    const platformPanelCount = covered(platformExpressions).length;
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
    await page.getByRole('button', { name: '主机资源', exact: true }).click();
    const hostFrame = page.frameLocator('iframe');
    assert.match(await page.locator('iframe').getAttribute('src'), /\/d\/bairui-host\//);
    for (const panel of assets['dashboard-host.json'].panels) {
      await hostFrame.getByText(panel.title, { exact: true }).waitFor({ timeout: 45000 });
      await hostFrame.getByText(panel.title, { exact: true }).scrollIntoViewIfNeeded();
    }
    const hostDeadline = Date.now() + 45000;
    while (covered(hostExpressions).length < hostExpressions.length && Date.now() < hostDeadline) await delay(100);
    await Promise.all([...pendingQueries]);
    assert.deepEqual(covered(hostExpressions).sort(), [...hostExpressions].sort(), 'all 24 host expressions must complete; late platform responses cannot count as host coverage');
    assert.deepEqual(failedQueries, []); assert.deepEqual(failedNative, []); assert.deepEqual(pageErrors, []);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(output, 'admin-host-' + width + '.png') });
    }
    const hostRetry = page.waitForResponse(response => response.url() === prefix + '/api/health');
    await page.getByRole('button', { name: '刷新监控', exact: true }).click(); await hostRetry;
    await page.frameLocator('iframe').getByText(assets['dashboard-host.json'].panels[0].title, { exact: true }).waitFor({ timeout: 45000 });
    assert.match(await page.locator('iframe').getAttribute('src'), /\/d\/bairui-host\//);
    await page.getByRole('button', { name: '平台运行', exact: true }).click();
    await page.frameLocator('iframe').getByText('API 可采集副本 / 预期 2', { exact: true }).waitFor({ timeout: 45000 });
    assert.equal(context.pages().length, 1);
    report.browser = { queriedPanels: platformPanelCount, hostPanels: covered(hostExpressions).length, hostExpressions: covered(hostExpressions), hostCollectionEnabled: false, httpErrors: [...failedNative], queryErrors: [...failedQueries], pageErrors: [...pageErrors],
      emptyDataAllowed: true, folderUid: (await document()).meta.folderUid };
    checks('browser admin switches between 12 platform and 24 host panels without query errors; host retry, desktop/mobile keep one tab and one origin');
    // Intentional suspension/outage checks below are separate from the healthy
    // browser phase; close its polling requests before injecting those faults.
    await context.close();
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
} catch (error) {
  report.error = error.message;
  if (browserPage) {
    report.failure = { url: browserPage.url(), frames: await Promise.all(browserPage.frames().map(async frame => ({ url: frame.url(), text: await frame.locator('body').innerText().catch(() => 'unavailable') }))) };
    await browserPage.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  for (const name of [names.grafana, names.prometheus, names.api, names.gateway]) await removeOwned('container', name);
  await removeOwned('network', names.network);
  await removeOwned('volume', names.volume);
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(resolve(directory).startsWith(join(resolve(tmpdir()), 'bairui-grafana-compat-')));
  await rm(directory, { recursive: true, force: true });
  report.cleaned = true;
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
