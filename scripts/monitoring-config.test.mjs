import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { monitoringStack, monitoringAssets, monitorNames, monitorImages, monitorOrigin } from './monitoring-config.mjs';
import { stackConfig, gatewayConfig } from './preprod-config.mjs';

const input = { installation: 'a'.repeat(24), nodeId: 'local-node', proxyIp: '10.0.1.3', revision: 'b'.repeat(16), schemaHash: 'c'.repeat(64) };

test('monitoring uses pinned bounded private services without host or database privileges', () => {
  const stack = monitoringStack(input);
  assert.deepEqual(Object.keys(stack.services).sort(), ['alertmanager', 'grafana', 'prometheus', 'receiver']);
  for (const service of Object.values(stack.services)) {
    assert.equal(service.ports, undefined);
    assert.deepEqual(service.networks, ['monitor']);
    assert.equal(service.read_only, true);
    assert.ok(service.user && !service.user.startsWith('0:'));
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.deepEqual(service.deploy.placement.constraints, ['node.id == local-node']);
    assert.ok(service.deploy.resources.limits.memory);
    assert.equal(service.deploy.update_config.order, 'stop-first');
    assert.ok(service.logging.options['max-size']);
    assert.ok(!service.image.endsWith(':latest'));
  }
  assert.equal(stack.networks.monitor.external.name, monitorNames.network);
  assert.equal(stack.services.grafana.environment.GF_AUTH_ANONYMOUS_ENABLED, 'false');
  assert.equal(stack.services.grafana.environment.GF_USERS_ALLOW_SIGN_UP, 'false');
  assert.equal(stack.services.grafana.environment.GF_SECURITY_COOKIE_SECURE, 'true');
  assert.equal(stack.services.grafana.environment.GF_SERVER_ROOT_URL, monitorOrigin);
  assert.ok(stack.services.grafana.environment.GF_SECURITY_ADMIN_PASSWORD__FILE);
  assert.equal(stack.services.grafana.environment.GF_ANALYTICS_REPORTING_ENABLED, 'false');
  assert.equal(stack.services.grafana.environment.GF_PLUGINS_PREINSTALL_DISABLED, 'true');
  assert.ok(stack.services.prometheus.command.includes('--storage.tsdb.retention.time=7d'));
  assert.ok(stack.services.prometheus.command.includes('--storage.tsdb.retention.size=1GB'));
  assert.ok(!JSON.stringify(stack).match(/docker.sock|DATABASE_URL|bairui-postgres|privileged/));
  assert.equal(Object.keys(stack.volumes).length, 4);
  assert.equal(Object.keys(stack.secrets).length, 3);
  assert.ok(Object.values(monitorImages).every(image => /:v?\d+\.\d+\.\d+$/.test(image)));
});

test('Prometheus discovers each API task and includes missing-data and notification alerts', () => {
  const files = monitoringAssets();
  const prom = files['prometheus.json'];
  const job = prom.scrape_configs.find(item => item.job_name === 'bairui-api');
  assert.deepEqual(job.dns_sd_configs[0].names, ['tasks.bairui-preprod_api']);
  assert.equal(job.dns_sd_configs[0].port, 9464);
  assert.equal(job.authorization.credentials_file, '/run/secrets/metrics-token');
  assert.ok(job.sample_limit && job.label_limit && job.body_size_limit);
  assert.equal(prom.global.scrape_interval, '15s');
  const rules = files['rules.json'].groups.flatMap(g => g.rules);
  assert.deepEqual(rules.map(r => r.alert).sort(), ['ApiReplicaMissing', 'DatabaseUnavailable', 'ApiErrorRateHigh', 'ApiLatencyHigh', 'DatabasePoolWaiting', 'MonitoringTargetDown', 'AlertDeliveryFailed'].sort());
  assert.ok(rules.find(r => r.alert === 'ApiReplicaMissing').expr.includes('or vector(0)'));
  assert.ok(rules.find(r => r.alert === 'DatabaseUnavailable').expr.includes('unless'));
  const am = files['alertmanager.json'];
  assert.equal(am.receivers.length, 1);
  const hook = am.receivers[0].webhook_configs[0];
  assert.equal(hook.send_resolved, true);
  assert.equal(hook.http_config.authorization.credentials_file, '/run/secrets/alert-token');
  assert.ok(hook.url.startsWith('http://bairui-monitor_receiver:9095/'));
  assert.ok(files['dashboard.json'].panels.length >= 8);
  assert.equal(files['datasources.json'].datasources[0].url, 'http://bairui-monitor_prometheus:9090');
});

test('existing preprod opt-in joins monitoring with metrics secret without expanding proxy trust', () => {
  assert.equal(stackConfig(input).services.api.environment.BAIRUI_METRICS_ENABLED, undefined);
  const stack = stackConfig({ ...input, monitoring: { enabled: true } });
  assert.equal(stack.services.api.environment.BAIRUI_METRICS_ENABLED, '1');
  assert.equal(stack.services.api.environment.BAIRUI_METRICS_PORT, '9464');
  assert.equal(stack.services.api.environment.BAIRUI_TRUSTED_PROXIES, '10.0.1.3/32');
  assert.ok(stack.services.api.networks.includes('monitor'));
  assert.equal(stack.networks.monitor.external.name, monitorNames.network);
  assert.equal(stack.secrets.metrics_token.external.name, monitorNames.metricsSecret);
  assert.ok(!stack.services.db.networks.includes('monitor'));
  assert.equal(stack.services.api.ports, undefined);
});

test('Caddy isolates Grafana and does not expose any metrics or collection endpoint', () => {
  const original = gatewayConfig();
  assert.ok(!original.includes(':9443'));
  const enabled = gatewayConfig({ monitoring: { enabled: true } });
  assert.ok(enabled.includes('https://localhost:9443'));
  assert.ok(enabled.includes('bairui-monitor_grafana:3000'));
  assert.ok(enabled.includes('handle @private {\n    respond 404\n  }'));
  assert.ok(enabled.indexOf('handle @private') < enabled.indexOf('handle @api'), 'deny_route_precedes_spa_fallback');
  assert.ok(!enabled.includes('reverse_proxy bairui-monitor_prometheus'));
  assert.ok(!enabled.includes('reverse_proxy bairui-monitor_alertmanager'));
  assert.ok(!enabled.includes('reverse_proxy bairui-monitor_receiver'));
});

test('monitoring config identifiers cannot inject compose or Docker targets', () => {
  for (const field of ['installation', 'nodeId', 'revision']) assert.throws(() => monitoringStack({ ...input, [field]: 'bad\nvalue' }));
});

test('acceptance report marks success only after footprint collection and resets on failure', async () => {
  const source = await readFile(new URL('./test-monitoring.mjs', import.meta.url), 'utf8');
  const collected = source.indexOf('report.footprint =');
  const successful = source.indexOf('report.success = true');
  assert.ok(collected > 0 && successful > collected, 'footprint_must_complete_before_success');
  assert.match(source, /catch \(error\)\s*\{\s*report\.success = false;/, 'all_failures_clear_success');
});
