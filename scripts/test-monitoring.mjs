import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { docker, localDocker, loadState, owned, containers, request, output, withLock, waitUntil, waitReady } from './preprod.mjs';
import { names, apiImage } from './preprod-config.mjs';
import { monitorNames, monitorServices, monitorSecrets, monitorImages, monitorOrigin } from './monitoring-config.mjs';
import { assertMonitoringResources, alertRecords, grafanaPassword } from './monitoring.mjs';
import { validateMonitoring } from './monitoring-rules.test.mjs';

const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
const report = { runId, success: false, startedAt: new Date().toISOString(), checks: [] };
const passed = message => { report.checks.push(message); console.log('通过：' + message); };
let state;

async function inApi(code, input = {}) {
  const rows = await containers(names.api, state);
  assert.ok(rows.length > 0, 'api_probe_container_missing');
  const prefix = 'const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString());';
  return JSON.parse(await docker(['exec', '-i', rows[0].Id, 'node', '--input-type=module', '-e', prefix + code], { input: JSON.stringify(input) }));
}

async function privateJson(service, path) {
  const address = { prometheus: monitorNames.prometheus + ':9090', alertmanager: monitorNames.alertmanager + ':9093' }[service];
  assert.ok(address);
  return inApi('const r=await fetch(input.url,{signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({status:r.status,body:await r.json()}));', { url: 'http://' + address + path });
}

async function verify() {
  state = await loadState();
  assert.ok(state?.monitoring?.enabled && state.monitoring.phase === 'running' && state.phase === 'running', '先运行 npm run monitor:up。');
  const local = await localDocker();
  assert.equal(local.nodeId, state.nodeId); assert.equal(local.endpoint, state.endpoint);
  await assertMonitoringResources(state);
  await validateMonitoring();
  const gateway = await owned('container', names.gateway, state);
  for (const [port, host] of [['443/tcp', '8443'], ['9443/tcp', '9443']]) {
    assert.deepEqual(gateway.HostConfig.PortBindings[port], [{ HostIp: '127.0.0.1', HostPort: host }]);
  }
  for (const key of monitorServices) {
    const service = await owned('service', monitorNames[key], state);
    assert.equal(service.Spec.EndpointSpec?.Ports?.length ?? 0, 0);
    assert.equal(service.Spec.Mode.Replicated.Replicas, 1);
  }
  await waitReady();
  const auth = JSON.parse((await request('/api/auth/config')).text);
  assert.deepEqual(auth.capabilities, { mode: 'platform', agentLifecycle: false, agentExecution: false, simulatedRecharge: false });
  for (const path of ['/metrics', '/metrics?token=not-a-secret', '/prometheus/api/v1/query', '/alertmanager/api/v2/alerts', '/alerts']) {
    assert.equal((await request(path)).status, 404, 'public_monitoring_path_denied');
  }
  assert.equal((await request(monitorOrigin + '/metrics')).status, 404);
  const unauth = await request(monitorOrigin + '/api/datasources');
  assert.ok([401, 403].includes(unauth.status));
  const password = await grafanaPassword(state);
  const headers = { authorization: 'Basic ' + Buffer.from('admin:' + password).toString('base64'), origin: monitorOrigin };
  const dashboard = await request(monitorOrigin + '/api/dashboards/uid/bairui-platform', { headers });
  assert.equal(dashboard.status, 200);
  assert.ok(JSON.parse(dashboard.text).dashboard.panels.length >= 8);
  const datasource = await request(monitorOrigin + '/api/datasources/uid/bairui-prometheus/health', { headers });
  assert.equal(datasource.status, 200);
  passed('CA 验证的 HTTPS、Grafana 独立认证、看板数据源、回环端口与平台监控路径隔离');

  await waitUntil(async () => {
    const result = await privateJson('prometheus', '/api/v1/targets');
    const targets = result.body.data?.activeTargets?.filter(t => t.labels.job === 'bairui-api') ?? [];
    return targets.length === 2 && targets.every(t => t.health === 'up') && new Set(targets.map(t => t.labels.instance)).size === 2;
  }, '两份 API 分别采集');
  const marker = 'private-' + randomBytes(12).toString('hex');
  await request('/api/unknown/' + marker + '?email=' + marker + '@example.test', { headers: { 'x-request-id': marker } });
  const metrics = await inApi(`
    const {readFile}=await import('node:fs/promises');
    const base='http://127.0.0.1:9464/metrics';
    const denied=await fetch(base);await denied.text();
    const token=(await readFile('/run/secrets/metrics-token','utf8')).trim();
    const result=await fetch(base,{headers:{authorization:'Bearer '+token}});const text=await result.text();
    console.log(JSON.stringify({denied:denied.status,status:result.status,hasSecret:text.includes(token)||text.includes(input.marker),
      hasHttp:text.includes('bairui_http_requests_total'),hasPool:text.includes('bairui_db_pool_connections'),ready:/bairui_database_ready(?:\\{[^}]*\\})? 1/.test(text)}));
  `, { marker });
  assert.deepEqual(metrics, { denied: 401, status: 200, hasSecret: false, hasHttp: true, hasPool: true, ready: true });
  for (const row of await containers(names.api, state)) {
    const logs = await docker(['logs', '--tail', '200', row.Id], { includeStderr: true });
    assert.ok(!logs.includes(marker) && !logs.includes(password), 'sensitive_log_marker');
  }
  passed('双 API 独立采集、专用指标 Bearer 认证、数据库与连接池指标、敏感标记不进入指标或日志');

  const secretIds = await Promise.all(monitorSecrets.map(async name => (await owned('secret', name, state)).ID));
  const started = new Date().toISOString();
  console.log('故障验收：仅将独立预发 API 从 2 份暂降至 1 份；完成后恢复 2 份，不操作数据库。');
  try {
    await docker(['service', 'scale', '--detach=true', names.api + '=1']);
    await waitUntil(async () => (await containers(names.api, state)).length === 1, '副本降为一份');
    await waitUntil(async () => {
      const result = await privateJson('prometheus', '/api/v1/alerts');
      return result.body.data.alerts.some(a => a.labels.alertname === 'ApiReplicaMissing' && a.state === 'firing');
    }, 'API 缺副本告警触发', 240000);
    await waitUntil(async () => (await alertRecords(state)).some(r => r.alertname === 'ApiReplicaMissing' && r.status === 'firing' && r.receivedAt >= started), '本地触发通知写入', 180000);
  } finally {
    await owned('service', names.api, state);
    await docker(['service', 'scale', '--detach=true', names.api + '=2']);
    await waitUntil(async () => {
      const rows = await containers(names.api, state);
      return rows.length === 2 && rows.every(c => c.State.Health?.Status === 'healthy' && c.Config.Image === apiImage(state.revision));
    }, '双 API 恢复');
    await waitReady();
  }
  await waitUntil(async () => (await alertRecords(state)).some(r => r.alertname === 'ApiReplicaMissing' && r.status === 'resolved' && r.receivedAt >= started), '本地恢复通知写入', 240000);
  passed('真实副本缺失：Prometheus 触发、Alertmanager 通知、接收器持久化、双副本恢复通知');

  const beforeRecords = await alertRecords(state);
  const old = {};
  for (const key of monitorServices) old[key] = (await containers(monitorNames[key], state))[0].Id;
  for (const key of monitorServices) await docker(['service', 'update', '--detach=true', '--force', monitorNames[key]]);
  await waitUntil(async () => {
    for (const key of monitorServices) {
      const rows = await containers(monitorNames[key], state);
      if (rows.length !== 1 || rows[0].Id === old[key] || rows[0].State.Health?.Status !== 'healthy') return false;
    }
    return true;
  }, '监控容器重建', 240000);
  assert.deepEqual(await Promise.all(monitorSecrets.map(async name => (await owned('secret', name, state)).ID)), secretIds);
  const afterRecords = await alertRecords(state, 1000);
  for (const record of beforeRecords) assert.ok(afterRecords.some(r => JSON.stringify(r) === JSON.stringify(record)));
  const history = await privateJson('prometheus', '/api/v1/query?query=' + encodeURIComponent('count_over_time(up{job="bairui-api"}[10m])'));
  assert.ok(history.body.data.result.some(r => Number(r.value[1]) >= 5));
  assert.equal((await request(monitorOrigin + '/api/dashboards/uid/bairui-platform', { headers })).status, 200);
  await waitReady();
  passed('监控四组件重启后，指标历史、告警记录、Grafana 登录及原 Secret 保留，平台健康');
  report.installation = state.installation; report.images = monitorImages;
  report.origin = monitorOrigin; report.receiptCount = afterRecords.length;
  const rows = [];
  for (const key of monitorServices) rows.push(...await containers(monitorNames[key], state));
  report.footprint = JSON.parse('[' + (await docker(['stats', '--no-stream', '--format', '{{json .}}', ...rows.map(row => row.Id)])).split('\n').join(',') + ']')
    .map(row => ({ name: row.Name, memory: row.MemUsage, cpu: row.CPUPerc }));
  report.success = true;
}

await withLock(async () => {
  try { await verify(); }
  catch (error) { report.success = false; report.error = error.message; console.error('监控验收失败：' + error.message); process.exitCode = 1; }
  finally {
    report.finishedAt = new Date().toISOString();
    const path = join(output, 'monitoring-acceptance-' + runId + '.json');
    await writeFile(path, JSON.stringify(report, null, 2) + '\n');
    console.log('脱敏验收报告：' + path);
  }
}).catch(error => { console.error(error.message); process.exitCode = 1; });
