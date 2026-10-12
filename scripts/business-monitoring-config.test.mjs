import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('./business-monitoring-config.mjs').catch(() => ({}));
const input = { installation: 'a'.repeat(24), revision: 'b'.repeat(16), directory: 'E:/cloud-agent/output/business-monitoring', gatewayIp: '172.28.0.3' };

test('official Caddy file capability is permitted in run and validator bounding sets', () => {
  for (const args of [module.businessContainerArguments('caddy', input), module.businessValidationArguments('caddy', input)]) {
    assert.ok(args.includes('--cap-add=NET_BIND_SERVICE'));
    assert.ok(args.includes('--cap-drop=ALL'));
    assert.deepEqual(args.filter(arg => arg.startsWith('--cap-add=')), ['--cap-add=NET_BIND_SERVICE']);
  }
});

test('business assets expose dedicated bounded targets and twelve fixed rules', () => {
  assert.equal(typeof module.businessAssets, 'function', 'business monitoring assets are missing');
  const files = module.businessAssets(), p = files['prometheus.json'];
  const api = p.scrape_configs.find(j => j.job_name === 'bairui-api');
  assert.deepEqual(api.static_configs[0].targets, ['host.docker.internal:9465']);
  assert.equal(api.dns_sd_configs, undefined);
  assert.equal(api.authorization.credentials_file, '/config/metrics-token');
  assert.ok(api.sample_limit && api.label_limit && api.body_size_limit);
  const runtime = p.scrape_configs.filter(j => j.job_name.startsWith('bairui-runtime-'));
  assert.deepEqual(runtime.map(j => j.static_configs[0].labels.environment), ['business', 'preprod']);
  assert.ok(runtime.every(j => j.static_configs[0].labels.job === 'bairui-runtime-controller'));
  assert.equal(new Set(runtime.map(j => j.authorization.credentials_file)).size, 2);
  const rules = files['rules.json'].groups.flatMap(g => g.rules);
  assert.equal(rules.length, 12);
  assert.equal(rules.find(r => r.alert === 'ApiReplicaMissing').expr, 'count(((sum(up{job="bairui-api"}) or vector(0)) < 1)) > 0');
  assert.equal(files['dashboard.json'].uid, 'bairui-platform');
  for (const panel of files['dashboard.json'].panels.filter(panel => panel.type === 'stat')) assert.equal(panel.targets[0].range, false);
  assert.ok(files['dashboard.json'].description?.includes('bairui-platform-folder'));
  assert.equal(files['dashboards.json'].providers[0].folderUid, 'bairui-platform-folder');
  assert.equal(files['dashboards.json'].providers[0].folder, 'BaiRui 业务监控');
  assert.equal(files['datasources.json'].datasources[0].url, 'http://bairui-business-monitor-prometheus:9090');
  assert.equal(files['alertmanager.json'], undefined);
});

test('bridge has an exact Bearer matcher, fixed query endpoints and Viewer forwarding', () => {
  assert.equal(typeof module.businessBridgeConfig, 'function');
  const config = module.businessBridgeConfig('c'.repeat(64));
  const routes = config.apps.http.servers.bridge.routes;
  assert.deepEqual(routes[0].match[0].header.Authorization, ['Bearer ' + 'c'.repeat(64)]);
  const proxyRoutes = routes[0].handle[0].routes;
  assert.deepEqual(proxyRoutes[0].match[0].path, ['/prometheus/api/v1/query', '/prometheus/api/v1/alerts']);
  assert.deepEqual(proxyRoutes[0].match[0].method, ['GET']);
  assert.equal(proxyRoutes[0].handle[0].strip_path_prefix, '/prometheus');
  assert.deepEqual(proxyRoutes[1].match[0].path, ['/api/admin/grafana/*']);
  const proxy = proxyRoutes[1].handle[0];
  assert.deepEqual(proxy.headers.request.set['X-Bairui-Monitor-Role'], ['Viewer']);
  assert.deepEqual(proxy.headers.request.set['X-Bairui-Monitor-User'], ['{http.request.header.X-Bairui-Monitor-User}']);
  for (const name of ['Cookie', 'Authorization', 'Forwarded', 'X-Forwarded-User', 'X-Forwarded-Role', 'X-WEBAUTH-USER']) assert.ok(proxy.headers.request.delete.includes(name));
  assert.ok(proxy.headers.response.delete.includes('Set-Cookie'));
  // Caddy applies deletion after setting. Never delete the forced identity headers.
  assert.ok(!proxy.headers.request.delete.includes('X-Bairui-Monitor-Role'));
  assert.ok(!proxy.headers.request.delete.includes('X-Bairui-Monitor-User'));
  assert.equal(routes.at(-1).handle[0].status_code, 401);
  assert.throws(() => module.businessBridgeConfig('invalid'));
});

test('only bridge publishes loopback while all containers are bounded non-root', () => {
  assert.equal(typeof module.businessContainerArguments, 'function');
  for (const kind of ['prometheus', 'grafana', 'caddy']) {
    const args = module.businessContainerArguments(kind, input);
    for (const flag of ['--init', '--restart=unless-stopped', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=128']) assert.ok(args.includes(flag));
    assert.ok(args.some(a => a.startsWith('--user=') && !a.startsWith('--user=0:')));
    assert.ok(args.some(a => a.startsWith('--memory=')) && args.some(a => a.startsWith('--cpus=')));
    assert.equal(args.includes('--publish'), kind === 'caddy');
    if (kind === 'caddy') assert.ok(args.includes('127.0.0.1:9493:8080'));
    assert.ok(!args.join(' ').includes('docker.sock'));
    assert.ok(!args.includes('--env-file'));
    assert.ok(args.includes('--pull=never'));
    assert.ok(!args.some(arg => arg.startsWith('--add-host=')), 'preserve Docker Desktop host.docker.internal resolution');
  }
});

test('Grafana uses exact live bridge IP, subpath and no login token', () => {
  assert.equal(typeof module.businessGrafanaEnvironment, 'function');
  const env = module.businessGrafanaEnvironment(input.gatewayIp);
  assert.equal(env.GF_AUTH_PROXY_WHITELIST, input.gatewayIp);
  assert.equal(env.GF_SERVER_ROOT_URL, 'http://localhost:5173/api/admin/grafana/');
  assert.equal(env.GF_SERVER_SERVE_FROM_SUB_PATH, 'true');
  assert.equal(env.GF_AUTH_PROXY_ENABLE_LOGIN_TOKEN, 'false');
  assert.equal(env.GF_AUTH_DISABLE_LOGIN_FORM, 'true');
  assert.equal(env.GF_AUTH_ANONYMOUS_ENABLED, 'false');
  assert.equal(env.GF_LIVE_MAX_CONNECTIONS, '0');
  assert.equal(env.GF_PLUGINS_PREINSTALL_DISABLED, 'true');
  assert.equal(env.GF_USERS_AUTO_ASSIGN_ORG_ROLE, 'Viewer');
  for (const bad of ['127.0.0.1', '172.28.0.0/16', '', '0.0.0.0']) assert.throws(() => module.businessGrafanaEnvironment(bad));
});

test('input validation rejects unknown containers, unsafe bind paths and ownership', () => {
  assert.equal(typeof module.assertBusinessOwned, 'function');
  module.assertBusinessOwned({ [module.businessLabel]: input.installation }, input.installation);
  assert.throws(() => module.assertBusinessOwned({ [module.businessLabel]: 'd'.repeat(24) }, input.installation), /business_resource_owner_mismatch/);
  for (const directory of ['relative', 'E:/output,x', 'E:/output\nconfig']) assert.throws(() => module.businessContainerArguments('caddy', { ...input, directory }));
  assert.throws(() => module.businessContainerArguments('api', input));
});

test('connector is a fixed absolute-path machine contract without inline secrets', () => {
  assert.equal(typeof module.businessConnector, 'function');
  const connector = module.businessConnector(input.installation, input.directory);
  assert.deepEqual(Object.keys(connector).sort(), ['version', 'installation', 'upstreamUrl', 'publicOrigin', 'metricsPort', 'bridgeTokenFile', 'metricsTokenFile'].sort());
  assert.equal(connector.upstreamUrl, 'http://127.0.0.1:9493');
  assert.equal(connector.metricsPort, 9465);
  assert.equal(connector.bridgeTokenFile.replaceAll('\\', '/'), input.directory + '/bridge-token');
  assert.equal(connector.publicOrigin, 'http://localhost:5173');
});

test('Grafana scrape follows its configured subpath without redirects', () => {
  assert.equal(module.businessAssets()['prometheus.json'].scrape_configs.find(j => j.job_name === 'grafana').metrics_path, '/api/admin/grafana/metrics');
});

test('business platform alerts aggregate labels for the existing strict shared receiver', () => {
  const rules = module.businessAssets()['rules.json'].groups[0].rules;
  assert.equal(rules.length, 7);
  for (const rule of rules) assert.ok(rule.expr.startsWith('count((') && rule.expr.endsWith(')) > 0'));
  assert.deepEqual(rules.find(r => r.alert === 'DatabaseUnavailable').labels, { severity: 'critical', environment: 'business', instance: '127.0.0.1:9465' });
  assert.ok(rules.find(r => r.alert === 'DatabaseUnavailable').expr.includes('== 0'), 'count must preserve a true zero-valued readiness alert');
});

test('official validators have bounded scratch space and mount only necessary private files', () => {
  assert.equal(typeof module.businessValidationArguments, 'function');
  const input = { directory: 'E:/cloud-agent/output/business-monitoring', runtimeTokenFiles: { business: 'E:/cloud-agent/output/runtime/business/controller/metrics-token', preprod: 'E:/cloud-agent/output/runtime/preprod/controller/metrics-token' } };
  for (const kind of ['prometheus', 'caddy']) {
    const args = module.businessValidationArguments(kind, input);
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('/tmp:rw,noexec,nosuid,size=64m'));
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.ok(args.some(arg => arg.startsWith('--user=') && !arg.startsWith('--user=0:')));
    assert.ok(!args.join(' ').includes('grafana-password'));
    assert.ok(!args.join(' ').includes('bridge-token'));
    assert.ok(args.includes(kind === 'prometheus' ? '/bin/promtool' : 'validate'));
  }
});

test('official rule scenarios exercise zero-valued database failures and aggregate labels', () => {
  assert.equal(typeof module.businessRuleTests, 'function');
  const scenarios = module.businessRuleTests();
  assert.ok(scenarios.tests.some(t => t.name === 'database_zero_is_failure'));
  assert.ok(scenarios.tests.some(t => t.name === 'one_business_replica_is_healthy'));
  for (const scenario of scenarios.tests) for (const rule of scenario.alert_rule_test) for (const alert of rule.exp_alerts) assert.equal(alert.exp_labels.environment, 'business');
});

test('all business alert fingerprints and persisted collector source differ from preprod without receiver changes', () => {
  for (const rule of module.businessAssets()['rules.json'].groups.flatMap(group => group.rules)) {
    assert.equal(rule.labels.environment, 'business');
    assert.equal(rule.labels.instance, '127.0.0.1:9465');
  }
});
