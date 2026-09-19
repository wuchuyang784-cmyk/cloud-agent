import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const monitorOrigin = 'https://localhost:9443';
export const monitorNames = Object.freeze({
  stack: 'bairui-monitor', network: 'bairui-preprod-monitor',
  prometheus: 'bairui-monitor_prometheus', grafana: 'bairui-monitor_grafana',
  alertmanager: 'bairui-monitor_alertmanager', receiver: 'bairui-monitor_receiver',
  promVolume: 'bairui-monitor-promdata', grafanaVolume: 'bairui-monitor-grafana',
  alertVolume: 'bairui-monitor-alertdata', receiverVolume: 'bairui-monitor-receipts',
  metricsSecret: 'bairui-monitor-metrics-token', alertSecret: 'bairui-monitor-alert-token',
  grafanaSecret: 'bairui-monitor-grafana-password',
});
export const monitorImages = Object.freeze({
  prometheus: 'prom/prometheus:v3.14.0', alertmanager: 'prom/alertmanager:v0.34.1', grafana: 'grafana/grafana:13.2.2',
});
export const monitorServices = ['prometheus', 'grafana', 'alertmanager', 'receiver'];
export const monitorVolumes = [monitorNames.promVolume, monitorNames.grafanaVolume, monitorNames.alertVolume, monitorNames.receiverVolume];
export const monitorSecrets = [monitorNames.metricsSecret, monitorNames.alertSecret, monitorNames.grafanaSecret];

export function monitoringAssets() {
  const rule = (alert, expr, duration = '1m', severity = 'warning') => ({ alert, expr, for: duration, labels: { severity } });
  const traffic = 'bairui_http_requests_total{job="bairui-api",route!~"/(livez|readyz|healthz)"}';
  const errorRate = 'sum(rate(bairui_http_requests_total{job="bairui-api",status=~"5..",route!~"/(livez|readyz|healthz)"}[5m])) / clamp_min(sum(rate(' + traffic + '[5m])), 0.001)';
  const latency = 'histogram_quantile(0.95, sum by (le) (rate(bairui_http_request_duration_seconds_bucket{job="bairui-api",route!~"/(livez|readyz|healthz)"}[5m])))';
  const rules = { groups: [{ name: 'bairui-preprod', interval: '15s', rules: [
    rule('ApiReplicaMissing', '(sum(up{job="bairui-api"}) or vector(0)) < 2', '45s', 'critical'),
    rule('DatabaseUnavailable', 'bairui_database_ready{job="bairui-api"} == 0 or (up{job="bairui-api"} == 1 unless on(instance) bairui_database_ready{job="bairui-api"})', '45s', 'critical'),
    rule('ApiErrorRateHigh', '(' + errorRate + ') > 0.05 and sum(increase(' + traffic + '[5m])) >= 20', '2m'),
    rule('ApiLatencyHigh', latency + ' > 1 and sum(increase(' + traffic + '[5m])) >= 20', '2m'),
    rule('DatabasePoolWaiting', 'bairui_db_pool_connections{job="bairui-api",state="waiting"} > 0', '1m'),
    rule('MonitoringTargetDown', 'up{job=~"prometheus|alertmanager|grafana"} == 0 or absent(up{job="alertmanager"}) or absent(up{job="grafana"})', '45s', 'critical'),
    rule('AlertDeliveryFailed', 'sum(increase(alertmanager_notifications_failed_total[5m])) > 0 or sum(increase(prometheus_notifications_errors_total[5m])) > 0', '30s', 'critical'),
  ] }] };
  const staticJob = (job_name, address) => ({ job_name, static_configs: [{ targets: [address] }], sample_limit: 10000, body_size_limit: '5MB' });
  const prometheus = {
    global: { scrape_interval: '15s', scrape_timeout: '8s', evaluation_interval: '15s' },
    rule_files: ['/etc/bairui/rules.json'],
    alerting: { alertmanagers: [{ static_configs: [{ targets: [monitorNames.alertmanager + ':9093'] }], timeout: '5s' }] },
    scrape_configs: [
      { job_name: 'bairui-api', authorization: { type: 'Bearer', credentials_file: '/run/secrets/metrics-token' },
        dns_sd_configs: [{ names: ['tasks.bairui-preprod_api'], type: 'A', port: 9464, refresh_interval: '5s' }],
        sample_limit: 10000, label_limit: 12, label_value_length_limit: 128, body_size_limit: '2MB',
      },
      staticJob('prometheus', 'localhost:9090'), staticJob('alertmanager', monitorNames.alertmanager + ':9093'),
      staticJob('grafana', monitorNames.grafana + ':3000'),
    ],
  };
  const alertmanager = {
    global: { resolve_timeout: '1m' },
    route: { receiver: 'local', group_by: ['alertname'], group_wait: '5s', group_interval: '15s', repeat_interval: '1h' },
    receivers: [{ name: 'local', webhook_configs: [{ url: 'http://' + monitorNames.receiver + ':9095/alerts',
      send_resolved: true, max_alerts: 64, http_config: { authorization: { type: 'Bearer', credentials_file: '/run/secrets/alert-token' } } }] }],
  };
  const datasource = { type: 'prometheus', uid: 'bairui-prometheus' };
  const panel = (id, title, expr, unit, type = 'timeseries', legend = '{{instance}}') => ({
    id, title, type, datasource, gridPos: { h: 8, w: 12, x: (id - 1) % 2 * 12, y: Math.floor((id - 1) / 2) * 8 },
    targets: [{ refId: 'A', expr, legendFormat: legend, ...(type === 'stat' ? { instant: true } : {}) }],
    fieldConfig: { defaults: { unit, decimals: 2, color: { mode: 'palette-classic' } }, overrides: [] },
    options: type === 'stat' ? { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } } : { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
  });
  const dashboard = { uid: 'bairui-platform', title: 'BaiRui 平台运行监控', tags: ['bairui', 'preprod'],
    schemaVersion: 39, version: 1, editable: false, timezone: 'browser', refresh: '15s', time: { from: 'now-30m', to: 'now' },
    panels: [
      panel(1, 'API 可采集副本 / 预期 2', 'sum(up{job="bairui-api"}) or vector(0)', 'short', 'stat', '可用副本'),
      panel(2, '数据库就绪 / 每 API', 'bairui_database_ready{job="bairui-api"}', 'short', 'stat'),
      panel(3, '业务请求速率', 'sum by(instance) (rate(' + traffic + '[5m]))', 'reqps'),
      panel(4, '业务请求 P95', latency, 's', 'timeseries', 'P95'),
      panel(5, '业务 5xx 比率', errorRate, 'percentunit', 'timeseries', '5xx'),
      panel(6, '正在处理的请求', 'bairui_http_requests_in_flight{job="bairui-api"}', 'short'),
      panel(7, '连接池总量 / 空闲 / 等待', 'bairui_db_pool_connections{job="bairui-api"}', 'short', 'timeseries', '{{instance}} {{state}}'),
      panel(8, '连接池上限', 'bairui_db_pool_max{job="bairui-api"}', 'short', 'stat'),
      panel(9, 'API 常驻内存', 'process_resident_memory_bytes{job="bairui-api"}', 'bytes'),
      panel(10, 'API CPU 使用核数', 'rate(process_cpu_seconds_total{job="bairui-api"}[5m])', 'short'),
      panel(11, '事件循环延迟 P99', 'nodejs_eventloop_lag_p99_seconds{job="bairui-api"}', 's'),
      panel(12, '当前触发告警', 'ALERTS{alertstate="firing"}', 'short', 'stat', '{{alertname}} {{instance}}'),
    ],
  };
  return {
    'prometheus.json': prometheus, 'rules.json': rules, 'alertmanager.json': alertmanager, 'dashboard.json': dashboard,
    'datasources.json': { apiVersion: 1, datasources: [{ ...datasource, name: 'BaiRui Prometheus', access: 'proxy',
      url: 'http://' + monitorNames.prometheus + ':9090', isDefault: true, editable: false, jsonData: { timeInterval: '15s' } }] },
    'dashboards.json': { apiVersion: 1, providers: [{ name: 'bairui', orgId: 1, folder: 'BaiRui', type: 'file', disableDeletion: true, allowUiUpdates: false, options: { path: '/etc/bairui/dashboards' } }] },
  };
}

export const monitoringRevision = () => createHash('sha256').update(JSON.stringify({ assets: monitoringAssets(), images: monitorImages })).digest('hex').slice(0, 16);
export const monitorConfigName = name => 'bairui-monitor-' + name.replace('.json', '') + '-' + monitoringRevision();

export function monitoringStack({ installation, nodeId, revision }) {
  assert.match(installation, /^[a-f0-9]{24}$/); assert.match(nodeId, /^[a-z0-9-]+$/); assert.match(revision, /^[a-f0-9]{16}$/);
  const labels = { 'bairui.preprod.installation': installation };
  const service = (image, user, memory, cpu) => ({ image, user, read_only: true, cap_drop: ['ALL'], labels,
    networks: ['monitor'], logging: { driver: 'json-file', options: { 'max-size': '5m', 'max-file': '3' } },
    stop_grace_period: '20s', deploy: { replicas: 1, labels, placement: { constraints: ['node.id == ' + nodeId] },
      resources: { limits: { cpus: cpu, memory }, reservations: { memory: '64M' } },
      restart_policy: { condition: 'any', delay: '5s' }, update_config: { parallelism: 1, order: 'stop-first', failure_action: 'pause' } },
  });
  const config = (source, target) => ({ source, target, mode: 292 });
  const secret = (source, target, uid) => ({ source, target, uid, gid: uid, mode: 256 });
  const health = (port, path) => ({ test: ['CMD', 'wget', '-q', '--spider', 'http://127.0.0.1:' + port + path], interval: '15s', timeout: '5s', retries: 3, start_period: '30s' });
  return {
    version: '3.8',
    services: {
      prometheus: { ...service(monitorImages.prometheus, '65534:65534', '512M', '0.50'),
        command: ['--config.file=/etc/bairui/prometheus.json', '--storage.tsdb.path=/prometheus', '--storage.tsdb.retention.time=7d', '--storage.tsdb.retention.size=1GB', '--query.max-concurrency=4', '--query.timeout=15s'],
        volumes: ['promdata:/prometheus'], configs: [config('prometheus.json', '/etc/bairui/prometheus.json'), config('rules.json', '/etc/bairui/rules.json')],
        secrets: [secret('metrics_token', 'metrics-token', '65534')], healthcheck: health(9090, '/-/ready'),
      },
      alertmanager: { ...service(monitorImages.alertmanager, '65534:65534', '128M', '0.20'),
        command: ['--config.file=/etc/bairui/alertmanager.json', '--storage.path=/alertmanager', '--cluster.listen-address=', '--data.retention=168h'],
        volumes: ['alertdata:/alertmanager'], configs: [config('alertmanager.json', '/etc/bairui/alertmanager.json')],
        secrets: [secret('alert_token', 'alert-token', '65534')], healthcheck: health(9093, '/-/ready'),
      },
      grafana: { ...service(monitorImages.grafana, '472:472', '384M', '0.50'),
        environment: { GF_SERVER_ROOT_URL: monitorOrigin, GF_SECURITY_ADMIN_USER: 'admin', GF_SECURITY_ADMIN_PASSWORD__FILE: '/run/secrets/grafana-password',
          GF_SECURITY_COOKIE_SECURE: 'true', GF_SECURITY_COOKIE_SAMESITE: 'strict', GF_AUTH_ANONYMOUS_ENABLED: 'false', GF_USERS_ALLOW_SIGN_UP: 'false',
          GF_ANALYTICS_REPORTING_ENABLED: 'false', GF_ANALYTICS_CHECK_FOR_UPDATES: 'false', GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
          GF_PLUGINS_PREINSTALL_DISABLED: 'true', GF_PLUGINS_PLUGIN_ADMIN_ENABLED: 'false', GF_SNAPSHOTS_EXTERNAL_ENABLED: 'false',
          GF_NEWS_NEWS_FEED_ENABLED: 'false', GF_UNIFIED_ALERTING_ENABLED: 'false', GF_LOG_MODE: 'console', GF_LOG_LEVEL: 'warn', GF_METRICS_ENABLED: 'true',
          GF_USERS_DEFAULT_LANGUAGE: 'zh-Hans', GF_AUTH_DISABLE_LOGIN_FORM: 'false',
        },
        volumes: ['grafanadata:/var/lib/grafana', { type: 'tmpfs', target: '/tmp', tmpfs: { size: 16777216 } }],
        configs: [config('datasources.json', '/etc/grafana/provisioning/datasources/bairui.yaml'), config('dashboards.json', '/etc/grafana/provisioning/dashboards/bairui.yaml'), config('dashboard.json', '/etc/bairui/dashboards/platform.json')],
        secrets: [secret('grafana_password', 'grafana-password', '472')], healthcheck: health(3000, '/api/health'),
      },
      receiver: { ...service('bairui/platform-api-preprod:' + revision, '1000:1000', '128M', '0.20'),
        command: ['node', 'src/monitoring/alert-receiver-index.mjs'],
        environment: { NODE_ENV: 'production', PORT: '9095', BAIRUI_ALERT_TOKEN_FILE: '/run/secrets/alert-token', BAIRUI_ALERT_DATA_DIR: '/data' },
        volumes: ['receipts:/data'], secrets: [secret('alert_token', 'alert-token', '1000')],
        healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:9095/livez',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: '15s', timeout: '3s', retries: 3 },
      },
    },
    networks: { monitor: { external: { name: monitorNames.network } } },
    volumes: { promdata: { external: { name: monitorNames.promVolume } }, grafanadata: { external: { name: monitorNames.grafanaVolume } }, alertdata: { external: { name: monitorNames.alertVolume } }, receipts: { external: { name: monitorNames.receiverVolume } } },
    secrets: { metrics_token: { external: { name: monitorNames.metricsSecret } }, alert_token: { external: { name: monitorNames.alertSecret } }, grafana_password: { external: { name: monitorNames.grafanaSecret } } },
    configs: Object.fromEntries(Object.keys(monitoringAssets()).map(name => [name, { external: { name: monitorConfigName(name) } }])),
  };
}
