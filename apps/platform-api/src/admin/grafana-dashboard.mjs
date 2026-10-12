// Provisioning and the browser-query gateway share this immutable expression set.
// No expression, datasource or upstream is selected by a browser.
const traffic = 'bairui_http_requests_total{job="bairui-api",route!~"/(livez|readyz|healthz)"}';
export const grafanaExpressions = Object.freeze([
  'sum(up{job="bairui-api"}) or vector(0)',
  'bairui_database_ready{job="bairui-api"}',
  'sum by(instance) (rate(' + traffic + '[5m]))',
  'histogram_quantile(0.95, sum by (le) (rate(bairui_http_request_duration_seconds_bucket{job="bairui-api",route!~"/(livez|readyz|healthz)"}[5m])))',
  'sum(rate(bairui_http_requests_total{job="bairui-api",status=~"5..",route!~"/(livez|readyz|healthz)"}[5m])) / clamp_min(sum(rate(' + traffic + '[5m])), 0.001)',
  'bairui_http_requests_in_flight{job="bairui-api"}',
  'bairui_db_pool_connections{job="bairui-api"}',
  'bairui_db_pool_max{job="bairui-api"}',
  'process_resident_memory_bytes{job="bairui-api"}',
  'rate(process_cpu_seconds_total{job="bairui-api"}[5m])',
  'nodejs_eventloop_lag_p99_seconds{job="bairui-api"}',
  'ALERTS{alertstate="firing"}',
  'bairui_host_cpu_usage_ratio{job="bairui-api"}',
  'bairui_host_memory_used_bytes{job="bairui-api"}',
  'bairui_host_memory_total_bytes{job="bairui-api"}',
  'up{job="bairui-runtime-controller"}',
  'bairui_runtime_controller_cycle_ok',
]);

export function businessDashboard() {
  const titles = ['业务 API 可采集副本 / 预期 1', '业务数据库就绪', '业务请求速率', '业务请求 P95', '业务 5xx 比率', '正在处理的请求',
    '数据库连接池 / 总量、空闲、等待', '数据库连接池上限', '业务 API 常驻内存', '业务 API CPU 使用核数', '事件循环延迟 P99', '当前触发告警',
    'Windows 主机 CPU 实际使用率', 'Windows 主机已用内存', 'Windows 主机总内存', 'Controller 采集状态 / 业务与预发', 'Controller 最近周期成功状态'];
  const units = ['short', 'short', 'reqps', 's', 'percentunit', 'short', 'short', 'short', 'bytes', 'short', 's', 'short', 'percentunit', 'bytes', 'bytes', 'short', 'short'];
  const datasource = { type: 'prometheus', uid: 'bairui-prometheus' };
  return { uid: 'bairui-platform', title: 'BaiRui 业务系统监控', tags: ['bairui', 'business'], schemaVersion: 39, version: 1, editable: false,
    description: '业务 API / PostgreSQL、Windows 宿主实际 CPU 与内存，以及业务 / 预发 Controller。固定文件夹 bairui-platform-folder；无活跃告警可为空，不以演示数据补齐。',
    timezone: 'browser', refresh: '15s', time: { from: 'now-30m', to: 'now' }, panels: grafanaExpressions.map((expr, index) => ({
      id: index + 1, title: titles[index], type: [0, 1, 7, 11, 14, 15, 16].includes(index) ? 'stat' : 'timeseries', datasource,
      gridPos: { h: 8, w: 12, x: index % 2 * 12, y: Math.floor(index / 2) * 8 },
      targets: [{ refId: 'A', expr, legendFormat: '{{instance}} {{state}}', ...([0, 1, 7, 11, 14, 15, 16].includes(index) ? { instant: true, range: false } : {}) }],
      fieldConfig: { defaults: { unit: units[index], decimals: 2, color: { mode: 'palette-classic' } }, overrides: [] },
      options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    })) };
}
