import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { monitoringAssets, monitorNames } from './monitoring-config.mjs';
import { runtimeRules } from './runtime-monitoring-config.mjs';
import { runtimeNames } from './runtime-deployment-config.mjs';
import { businessDashboard } from '../apps/platform-api/src/admin/grafana-dashboard.mjs';

export const businessLabel = 'bairui.business-monitoring.installation';
export const businessNames = Object.freeze({
  network: 'bairui-business-monitor', prometheus: 'bairui-business-monitor-prometheus',
  grafana: 'bairui-business-monitor-grafana', caddy: 'bairui-business-monitor-bridge',
  promVolume: 'bairui-business-monitor-promdata', grafanaVolume: 'bairui-business-monitor-grafanadata',
});
export const businessImages = Object.freeze({ prometheus: 'prom/prometheus:v3.14.0', grafana: 'grafana/grafana:13.2.2', caddy: 'caddy:2.10.2-alpine' });
export const businessKinds = Object.freeze(['prometheus', 'grafana', 'caddy']);
export const businessVolumes = Object.freeze([businessNames.promVolume, businessNames.grafanaVolume]);
export const businessCredentials = Object.freeze(['bridge-token', 'metrics-token', 'grafana-password']);

export function assertBusinessOwned(labels, installation) {
  assert.match(installation, /^[a-f0-9]{24}$/, 'invalid_business_installation');
  assert.equal(labels?.[businessLabel], installation, 'business_resource_owner_mismatch');
}

export function businessAssets() {
  const files = structuredClone(monitoringAssets());
  delete files['alertmanager.json'];
  files['rules.json'].groups[0].name = 'bairui-business';
  files['rules.json'].groups[0].rules.find(r => r.alert === 'ApiReplicaMissing').expr = '(sum(up{job="bairui-api"}) or vector(0)) < 1';
  // The shared receiver accepts fixed aggregate alerts. Count preserves zero-valued
  // predicates (database_ready == 0), while removing arbitrary scrape instance labels.
  for (const rule of files['rules.json'].groups[0].rules) rule.expr = 'count((' + rule.expr + ')) > 0';
  files['rules.json'].groups.push(...runtimeRules().groups);
  for (const rule of files['rules.json'].groups.flatMap(group => group.rules)) {
    // Stable collector provenance: unique Alertmanager fingerprints; legacy receiver
    // preserves the bounded IP:port instance even though it omits environment.
    Object.assign(rule.labels, { environment: 'business', instance: '127.0.0.1:9465' });
  }
  const prom = files['prometheus.json'];
  const api = prom.scrape_configs.find(j => j.job_name === 'bairui-api');
  delete api.dns_sd_configs;
  api.static_configs = [{ targets: ['host.docker.internal:9465'], labels: { environment: 'business' } }];
  api.authorization.credentials_file = '/config/metrics-token';
  const grafana = prom.scrape_configs.find(j => j.job_name === 'grafana');
  grafana.static_configs[0].targets = [businessNames.grafana + ':3000'];
  grafana.metrics_path = '/api/admin/grafana/metrics';
  for (const environment of ['business', 'preprod']) prom.scrape_configs.push({
    job_name: 'bairui-runtime-' + environment,
    static_configs: [{ targets: [runtimeNames(environment).controller + ':9495'], labels: { job: 'bairui-runtime-controller', environment, instance: environment } }],
    authorization: { type: 'Bearer', credentials_file: '/run/secrets/runtime-' + environment + '-metrics' },
    relabel_configs: [{ target_label: 'job', replacement: 'bairui-runtime-controller' }],
    sample_limit: 100, label_limit: 12, label_value_length_limit: 128, body_size_limit: '128KB',
  });
  files['dashboard.json'] = businessDashboard();
  files['dashboards.json'].providers[0].folderUid = 'bairui-platform-folder';
  files['dashboards.json'].providers[0].folder = 'BaiRui 业务监控';
  files['datasources.json'].datasources[0].url = 'http://' + businessNames.prometheus + ':9090';
  files['rule-tests.json'] = businessRuleTests();
  return files;
}

export function businessRuleTests() {
  const series = (name, values = '1+0x40') => ({ series: name, values });
  const api = series('up{job="bairui-api",instance="host.docker.internal:9465"}');
  const ready = values => series('bairui_database_ready{job="bairui-api",instance="host.docker.internal:9465"}', values);
  const infrastructure = ['prometheus', 'alertmanager', 'grafana'].map(job => series('up{job="' + job + '",instance="fixed-validation"}'));
  const alert = (alertname, firing = false, severity = 'critical', eval_time = '2m') => ({ alertname, eval_time,
    exp_alerts: firing ? [{ exp_labels: { severity, environment: 'business', instance: '127.0.0.1:9465' }, exp_annotations: {} }] : [] });
  return { rule_files: ['/etc/bairui/rules.json'], evaluation_interval: '15s', tests: [
    { name: 'one_business_replica_is_healthy', interval: '15s', input_series: [...infrastructure, api, ready()], alert_rule_test: [alert('ApiReplicaMissing'), alert('DatabaseUnavailable'), alert('MonitoringTargetDown')] },
    { name: 'missing_business_api', interval: '15s', input_series: infrastructure, alert_rule_test: [alert('ApiReplicaMissing', true)] },
    { name: 'database_zero_is_failure', interval: '15s', input_series: [...infrastructure, api, ready('0+0x40')], alert_rule_test: [alert('DatabaseUnavailable', true)] },
    { name: 'missing_database_metric', interval: '15s', input_series: [...infrastructure, api], alert_rule_test: [alert('DatabaseUnavailable', true)] },
    { name: 'database_pool_waiting', interval: '15s', input_series: [...infrastructure, api, ready(), series('bairui_db_pool_connections{job="bairui-api",instance="host.docker.internal:9465",state="waiting"}')], alert_rule_test: [alert('DatabasePoolWaiting', true, 'warning')] },
    { name: 'business_grafana_down', interval: '15s', input_series: [...infrastructure.slice(0, 2), series('up{job="grafana",instance="bairui-business-monitor-grafana:3000"}', '0+0x40'), api, ready()], alert_rule_test: [alert('MonitoringTargetDown', true)] },
    { name: 'business_delivery_failure', interval: '15s', input_series: [...infrastructure, api, ready(), series('prometheus_notifications_errors_total{instance="fixed-validation"}', '0+1x40')], alert_rule_test: [alert('AlertDeliveryFailed', true)] },
    { name: 'business_error_rate', interval: '15s', input_series: [...infrastructure, api, ready(),
      series('bairui_http_requests_total{job="bairui-api",instance="host.docker.internal:9465",route="/api/user/agents",status="200"}', '0+20x40'),
      series('bairui_http_requests_total{job="bairui-api",instance="host.docker.internal:9465",route="/api/user/agents",status="500"}', '0+5x40')], alert_rule_test: [alert('ApiErrorRateHigh', true, 'warning', '8m')] },
    { name: 'business_latency', interval: '15s', input_series: [...infrastructure, api, ready(),
      series('bairui_http_requests_total{job="bairui-api",instance="host.docker.internal:9465",route="/api/user/agents",status="200"}', '0+5x40'),
      ...[['1', '0+0x40'], ['2', '0+5x40'], ['+Inf', '0+5x40']].map(([le, values]) => series('bairui_http_request_duration_seconds_bucket{job="bairui-api",instance="host.docker.internal:9465",route="/api/user/agents",le="' + le + '"}', values))],
      alert_rule_test: [alert('ApiLatencyHigh', true, 'warning', '8m')] },
  ] };
}

export function businessGrafanaEnvironment(gatewayIp) {
  assert.ok(isIP(gatewayIp) === 4 && !/^(0|127|169|224|255)\./.test(gatewayIp), 'exact_business_bridge_ip_required');
  return {
    GF_SERVER_ROOT_URL: 'http://localhost:5173/api/admin/grafana/', GF_SERVER_SERVE_FROM_SUB_PATH: 'true',
    GF_SECURITY_ADMIN_USER: 'admin', GF_SECURITY_ADMIN_PASSWORD__FILE: '/config/grafana-password',
    GF_SECURITY_COOKIE_SAMESITE: 'strict', GF_SECURITY_ALLOW_EMBEDDING: 'true',
    GF_AUTH_ANONYMOUS_ENABLED: 'false', GF_AUTH_DISABLE_LOGIN_FORM: 'true', GF_USERS_ALLOW_SIGN_UP: 'false',
    GF_AUTH_PROXY_ENABLED: 'true', GF_AUTH_PROXY_HEADER_NAME: 'X-Bairui-Monitor-User', GF_AUTH_PROXY_HEADER_PROPERTY: 'username',
    GF_AUTH_PROXY_AUTO_SIGN_UP: 'true', GF_AUTH_PROXY_ENABLE_LOGIN_TOKEN: 'false', GF_USERS_AUTO_ASSIGN_ORG_ROLE: 'Viewer',
    GF_AUTH_PROXY_HEADERS: 'Role:X-Bairui-Monitor-Role', GF_AUTH_PROXY_SYNC_TTL: '0', GF_AUTH_PROXY_WHITELIST: gatewayIp,
    GF_ANALYTICS_REPORTING_ENABLED: 'false', GF_ANALYTICS_CHECK_FOR_UPDATES: 'false', GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
    GF_PLUGINS_PREINSTALL_DISABLED: 'true', GF_PLUGINS_PLUGIN_ADMIN_ENABLED: 'false', GF_SNAPSHOTS_EXTERNAL_ENABLED: 'false',
    GF_NEWS_NEWS_FEED_ENABLED: 'false', GF_UNIFIED_ALERTING_ENABLED: 'false', GF_LOG_MODE: 'console', GF_LOG_LEVEL: 'warn',
    GF_METRICS_ENABLED: 'true', GF_USERS_DEFAULT_LANGUAGE: 'zh-Hans', GF_LIVE_MAX_CONNECTIONS: '0',
  };
}

export function businessBridgeConfig(token) {
  assert.match(token, /^[a-f0-9]{64}$/, 'invalid_business_bridge_token');
  const proxy = (dial, identity = false) => ({ handler: 'reverse_proxy', upstreams: [{ dial }],
    transport: { protocol: 'http', dial_timeout: '3s', response_header_timeout: '10s' },
    headers: { request: { delete: ['Cookie', 'Authorization', 'Forwarded', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Forwarded-User', 'X-Forwarded-Role', 'X-WEBAUTH-USER', 'X-WEBAUTH-ROLE', ...(identity ? [] : ['X-Bairui-Monitor-User', 'X-Bairui-Monitor-Role'])],
      ...(identity ? { set: { 'X-Bairui-Monitor-User': ['{http.request.header.X-Bairui-Monitor-User}'], 'X-Bairui-Monitor-Role': ['Viewer'] } } : {}) },
      response: { delete: ['Set-Cookie', 'Authorization', 'X-Bairui-Monitor-User', 'X-Bairui-Monitor-Role'] } } });
  return { admin: { disabled: true }, logging: { logs: { default: { level: 'WARN' } } }, apps: { http: { servers: { bridge: {
    listen: [':8080'], read_header_timeout: '5s', read_timeout: '15s', write_timeout: '20s', idle_timeout: '30s', max_header_bytes: 16384,
    routes: [
      { match: [{ header: { Authorization: ['Bearer ' + token] } }], handle: [{ handler: 'subroute', routes: [
        { match: [{ path: ['/prometheus/api/v1/query', '/prometheus/api/v1/alerts'], method: ['GET'] }], handle: [{ handler: 'rewrite', strip_path_prefix: '/prometheus' }, proxy(businessNames.prometheus + ':9090')], terminal: true },
        { match: [{ path: ['/api/admin/grafana/*'], method: ['GET', 'HEAD', 'POST'] }], handle: [proxy(businessNames.grafana + ':3000', true)], terminal: true },
        { handle: [{ handler: 'static_response', status_code: 404 }] },
      ] }], terminal: true },
      { handle: [{ handler: 'static_response', status_code: 401 }] },
    ],
  } } } } };
}

function directoryPath(directory) {
  assert.ok(typeof directory === 'string' && isAbsolute(directory) && !/[\r\n,]/.test(directory), 'invalid_business_monitoring_directory');
  return directory.replaceAll('\\', '/').replace(/\/$/, '');
}

export function businessConnector(installation, directory) {
  assert.match(installation, /^[a-f0-9]{24}$/);
  directoryPath(directory);
  return { version: 1, installation, upstreamUrl: 'http://127.0.0.1:9493', publicOrigin: 'http://localhost:5173', metricsPort: 9465,
    bridgeTokenFile: join(directory, 'bridge-token'), metricsTokenFile: join(directory, 'metrics-token') };
}

export function businessContainerArguments(kind, { installation, revision, directory, gatewayIp, runtimeTokenFiles = {} }) {
  assert.ok(businessKinds.includes(kind), 'invalid_business_monitoring_kind');
  assert.match(installation, /^[a-f0-9]{24}$/); assert.match(revision, /^[a-f0-9]{16}$/);
  const path = directoryPath(directory), user = { prometheus: '65534:65534', grafana: '472:472', caddy: '1000:1000' }[kind];
  const args = ['run', '-d', '--pull=never', '--name', businessNames[kind], '--label', businessLabel + '=' + installation,
    '--label', 'bairui.business-monitoring.revision=' + revision, '--restart=unless-stopped', '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--user=' + user, '--cpus=0.50', '--memory=' + (kind === 'prometheus' ? '512m' : kind === 'grafana' ? '384m' : '128m'), '--pids-limit=128',
    '--network', businessNames.network, '--log-driver=json-file', '--log-opt=max-size=5m', '--log-opt=max-file=3',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m',
  ];
  const mount = (source, target, type = 'bind', readonly = true) => args.push('--mount', 'type=' + type + ',source=' + source + ',target=' + target + (readonly ? ',readonly' : ''));
  if (kind === 'prometheus') {
    mount(path + '/prometheus.json', '/etc/bairui/prometheus.json'); mount(path + '/rules.json', '/etc/bairui/rules.json'); mount(path + '/metrics-token', '/config/metrics-token');
    mount(businessNames.promVolume, '/prometheus', 'volume', false);
    for (const environment of ['business', 'preprod']) if (runtimeTokenFiles[environment]) mount(directoryPath(runtimeTokenFiles[environment]), '/run/secrets/runtime-' + environment + '-metrics');
  } else if (kind === 'grafana') {
    mount(path + '/grafana-password', '/config/grafana-password'); mount(path + '/datasources.json', '/etc/grafana/provisioning/datasources/bairui.yaml');
    mount(path + '/dashboards.json', '/etc/grafana/provisioning/dashboards/bairui.yaml'); mount(path + '/dashboard.json', '/etc/bairui/dashboards/platform.json');
    mount(businessNames.grafanaVolume, '/var/lib/grafana', 'volume', false);
    for (const [key, value] of Object.entries(businessGrafanaEnvironment(gatewayIp))) args.push('--env', key + '=' + value);
  } else {
    // Official Caddy binary has this file capability; keep it in the bounding set.
    args.push('--cap-add=NET_BIND_SERVICE');
    mount(path + '/caddy.json', '/config/caddy.json'); mount(path + '/bridge-token', '/config/bridge-token');
    args.push('--publish', '127.0.0.1:9493:8080', '--env', 'XDG_CONFIG_HOME=/tmp/config', '--env', 'XDG_DATA_HOME=/tmp/data');
  }
  const health = kind === 'prometheus' ? 'wget -q --spider http://127.0.0.1:9090/-/ready'
    : kind === 'grafana' ? 'wget -q --spider http://127.0.0.1:3000/api/admin/grafana/api/health'
      : 'wget -q -O /dev/null --header "Authorization: Bearer $(cat /config/bridge-token)" "http://127.0.0.1:8080/prometheus/api/v1/query?query=vector%281%29"';
  args.push('--health-cmd', health, '--health-interval=10s', '--health-timeout=5s', '--health-retries=3', '--health-start-period=20s', businessImages[kind]);
  if (kind === 'prometheus') args.push('--config.file=/etc/bairui/prometheus.json', '--storage.tsdb.path=/prometheus', '--storage.tsdb.retention.time=7d', '--storage.tsdb.retention.size=1GB', '--query.max-concurrency=4', '--query.timeout=15s');
  if (kind === 'caddy') args.push('caddy', 'run', '--config', '/config/caddy.json');
  return args;
}

export function businessValidationArguments(kind, { directory, runtimeTokenFiles = {} }, command = 'check') {
  assert.ok(['prometheus', 'caddy'].includes(kind), 'invalid_business_validator');
  const path = directoryPath(directory);
  const args = ['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=256m', '--cpus=0.50', '--pids-limit=32'];
  const mount = (source, target) => args.push('--mount', 'type=bind,source=' + source + ',target=' + target + ',readonly');
  if (kind === 'prometheus') {
    for (const file of ['prometheus.json', 'rules.json', 'rule-tests.json']) mount(path + '/' + file, '/etc/bairui/' + file);
    mount(path + '/metrics-token', '/config/metrics-token');
    for (const environment of ['business', 'preprod']) mount(directoryPath(runtimeTokenFiles[environment]), '/run/secrets/runtime-' + environment + '-metrics');
    args.push('--user=65534:65534', '--entrypoint', '/bin/promtool', businessImages.prometheus);
    assert.ok(['check', 'test'].includes(command), 'invalid_business_validator_command');
    args.push(...(command === 'test' ? ['test', 'rules', '/etc/bairui/rule-tests.json'] : ['check', 'config', '/etc/bairui/prometheus.json']));
  } else {
    args.push('--cap-add=NET_BIND_SERVICE');
    mount(path + '/caddy.json', '/config/caddy.json');
    args.push('--user=1000:1000', '--env', 'XDG_CONFIG_HOME=/tmp/config', '--env', 'XDG_DATA_HOME=/tmp/data', businessImages.caddy, 'caddy', 'validate', '--config', '/config/caddy.json');
  }
  return args;
}

export function businessRevision() {
  return createHash('sha256').update(JSON.stringify({ assets: businessAssets(), images: businessImages, bridge: businessBridgeConfig('0'.repeat(64)),
    args: businessKinds.map(kind => businessContainerArguments(kind, { installation: '0'.repeat(24), revision: '0'.repeat(16), directory: 'C:/bairui-monitor', gatewayIp: '172.28.0.3' })) })).digest('hex').slice(0, 16);
}
