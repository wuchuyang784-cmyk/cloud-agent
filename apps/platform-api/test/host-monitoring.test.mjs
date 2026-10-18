import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrafanaProxy } from '../src/admin/grafana-proxy.mjs';
import { monitoringAssets, monitoringStack } from '../../../scripts/monitoring-config.mjs';
import { businessDashboard } from '../src/admin/grafana-dashboard.mjs';

const host = await import('../src/admin/host-dashboard.mjs').catch(() => ({}));

test('host dashboard is a separate fixed read-only dashboard with explicit unavailable values', () => {
  assert.equal(typeof host.hostDashboard, 'function', 'hostDashboard export is required');
  const dashboard = host.hostDashboard();
  assert.equal(dashboard.uid, 'bairui-host');
  assert.equal(dashboard.editable, false);
  assert.deepEqual(dashboard.templating.list, []);
  assert.ok(dashboard.panels.length >= 20 && dashboard.panels.length <= 26);
  assert.equal(Object.isFrozen(host.hostDashboardExpressions), true);
  assert.deepEqual(dashboard.panels.flatMap(panel => panel.targets.map(target => target.expr)), host.hostDashboardExpressions);
  for (const panel of dashboard.panels) {
    assert.deepEqual(panel.datasource, { type: 'prometheus', uid: 'bairui-prometheus' });
    assert.equal(panel.fieldConfig.defaults.noValue, '未采集 / 不可用');
    if (panel.type === 'stat') assert.deepEqual([panel.targets[0].instant, panel.targets[0].range], [true, false]);
  }
  assert.match(dashboard.description, /Linux/);
  assert.match(dashboard.description, /Docker Desktop.*VM/);
  for (const panel of dashboard.panels.filter(panel => /累计/.test(panel.title))) {
    assert.match(panel.title, /网卡计数.*自启动或重置以来/);
    assert.doesNotMatch(panel.title, /主机启动以来/);
  }
});

test('all host resource expressions require a live scrape and nonfuture sampler age within 45 seconds', () => {
  assert.ok(Array.isArray(host.hostDashboardExpressions), 'fixed host expressions are required');
  const expressions = host.hostDashboardExpressions;
  assert.equal(expressions[0], 'up{job="bairui-host"}');
  assert.equal(expressions[1], 'bairui_host_metrics_sample_timestamp_seconds{job="bairui-host"} * 1000', 'Grafana dateTime units require milliseconds');
  for (const expr of expressions.slice(3)) {
    assert.match(expr, /and on\(instance\) \(up\{job="bairui-host"\} == 1\)/);
    assert.match(expr, /time\(\) - bairui_host_metrics_sample_timestamp_seconds\{job="bairui-host"\}\) >= 0/);
    assert.match(expr, /time\(\) - bairui_host_metrics_sample_timestamp_seconds\{job="bairui-host"\}\) <= 45/);
    assert.doesNotMatch(expr, /or vector\(0\)|clamp_min/);
  }
  const joined = expressions.join('\n');
  for (const metric of ['node_boot_time_seconds', 'node_cpu_seconds_total', 'node_memory_MemAvailable_bytes', 'node_memory_SwapTotal_bytes',
    'node_filesystem_avail_bytes', 'node_filesystem_files_free', 'node_disk_read_bytes_total', 'node_disk_written_bytes_total',
    'node_network_receive_bytes_total', 'node_network_transmit_bytes_total', 'node_network_receive_errs_total', 'node_network_transmit_drop_total']) assert.ok(joined.includes(metric), metric);
  assert.doesNotMatch(joined, /\[5m\]|node_memory_SwapTotal_bytes[^\n]*\//);
  assert.match(joined, /rate\(node_network_receive_bytes_total\{job="bairui-host"\}\[1m\]\)/);
});

test('host asset is provisioned alongside the unchanged platform and business dashboards', () => {
  const assets = monitoringAssets();
  assert.equal(assets['dashboard-host.json']?.uid, 'bairui-host');
  assert.equal(assets['dashboard.json'].uid, 'bairui-platform');
  assert.equal(assets['dashboard.json'].version, 2);
  assert.equal(assets['dashboard.json'].panels.length, 12);
  assert.equal(assets['dashboards.json'].providers[0].folderUid, 'bairui-platform-folder');
  assert.equal(businessDashboard().panels.length, 17);
  const stack = monitoringStack({ installation: 'a'.repeat(24), nodeId: 'test-node', revision: 'b'.repeat(16), monitoring: { gatewayIp: '172.20.0.4' } });
  assert.ok(stack.services.grafana.configs.some(config => config.source === 'dashboard-host.json' && config.target === '/etc/bairui/dashboards/host.json'));
});

async function proxyRequest(path, body) {
  const seen = [];
  const proxy = createGrafanaProxy({ baseUrl: 'http://127.0.0.1:9493', token: 'a'.repeat(64), publicOrigin: 'http://localhost:5173',
    fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response('{}'); } });
  let status;
  const url = new URL('http://localhost:5173/api/admin/grafana/' + path);
  await proxy.handle({ request: { url: url.pathname + url.search, method: body ? 'POST' : 'GET', headers: body ? { origin: url.origin, 'content-type': 'application/json' } : {} },
    url, principal: { userId: 'viewer' }, readJson: async () => body,
    response: { destroyed: false, writeHead: code => { status = code; }, end() {} }, fail: code => { status = code; } });
  return { status, seen };
}

test('host proxy permits only the fixed host routes and exact dashboard UID filters', async () => {
  for (const path of ['d/bairui-host/bairui-host?kiosk', 'api/dashboards/uid/bairui-host',
    'apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/bairui-host/dto',
    'apis/dashboard.grafana.app/v2/namespaces/default/dashboards/bairui-host/dto',
    'api/annotations?dashboardUID=bairui-host', 'api/search?dashboardUID=bairui-host']) assert.equal((await proxyRequest(path)).status, 200, path);
  for (const path of ['d/bairui-host/other', 'api/dashboards/uid/other', 'apis/dashboard.grafana.app/v2/namespaces/default/dashboards/other/dto']) assert.equal((await proxyRequest(path)).status, 404, path);
  for (const path of ['api/annotations?dashboardUID=other', 'api/search?dashboardUID=other', 'api/user?dashboardUID=bairui-host',
    'api/search?dashboardUID=bairui-host&dashboardUID=other']) assert.equal((await proxyRequest(path)).status, 422, path);
});

test('host proxy accepts every fixed resource expression and refuses arbitrary queries or datasource UIDs', async () => {
  assert.ok(Array.isArray(host.hostDashboardExpressions), 'host query allowlist is required');
  const query = expr => ({ from: String(Date.now() - 60000), to: String(Date.now()), queries: [{ refId: 'A', expr, datasource: { type: 'prometheus', uid: 'bairui-prometheus' } }] });
  for (const expr of host.hostDashboardExpressions) assert.equal((await proxyRequest('api/ds/query', query(expr))).status, 200, expr);
  assert.equal((await proxyRequest('api/ds/query', query('node_memory_MemTotal_bytes'))).status, 422);
  const body = query(host.hostDashboardExpressions[0]); body.queries[0].datasource.uid = 'other';
  assert.equal((await proxyRequest('api/ds/query', body)).status, 422);
});
