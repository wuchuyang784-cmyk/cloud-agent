import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadBusinessMonitoringEnv } from '../apps/platform-api/src/admin/business-monitoring-env.mjs';
import { loadBusinessState, assertBusinessResources, businessStop, businessUp, withBusinessLock, businessOutput } from './business-monitoring.mjs';
import { businessNames, businessCredentials, businessVolumes, assertBusinessOwned } from './business-monitoring-config.mjs';
import { docker, inspect, loadState, containers, root, waitUntil } from './preprod.mjs';
import { names } from './preprod-config.mjs';
import { monitorNames, monitorServices } from './monitoring-config.mjs';
import { alertRecords } from './monitoring.mjs';
import { hasPersistedResolution } from './monitoring-evidence.mjs';
import { runWithKeepAlive } from './cli-keepalive.mjs';

// --faults affects only the three exactly owned business-monitoring containers.
// No business credentials, users, migrations or original preprod services change.
const faults = process.argv.includes('--faults');
const report = { success: false, startedAt: new Date().toISOString(), faults, checks: [], metrics: {} };
const check = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log('PASS:', name); };
const env = await loadBusinessMonitoringEnv({ BAIRUI_ADMIN_MONITORING_CONFIG_FILE: join(businessOutput, 'connector.json') });
const headers = { authorization: 'Bearer ' + env.BAIRUI_MONITORING_PROXY_TOKEN };
async function query(expression) {
  const result = await fetch(env.BAIRUI_PROMETHEUS_URL + '/api/v1/query?query=' + encodeURIComponent(expression), { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(result.status, 200); const data = await result.json(); assert.equal(data.status, 'success'); return data.data.result;
}
async function privateSnapshot() {
  const files = [join(root, 'output/preprod/root.crt'), join(root, 'output/preprod/state.json'),
    ...['business', 'preprod'].flatMap(environment => ['controller/controller.json', 'orchestrator/orchestrator.json', 'controller/metrics-token', 'state.json'].map(file => join(root, 'output/runtime', environment, file))),
    ...businessCredentials.map(file => join(businessOutput, file))];
  return Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
}
async function preprodSnapshot(state) {
  const result = {};
  for (const service of [names.api, names.db, ...monitorServices.map(key => monitorNames[key])]) {
    result[service] = (await containers(service, state)).map(item => ({ id: item.Id, startedAt: item.State.StartedAt })).sort((a, b) => a.id.localeCompare(b.id));
  }
  for (const name of [names.gateway, 'bairui-postgres', 'bairui-runtime-business-controller', 'bairui-runtime-business-orchestrator', 'bairui-runtime-preprod-controller', 'bairui-runtime-preprod-orchestrator']) {
    const item = await inspect('container', name); assert.ok(item?.State.Running); result[name] = { id: item.Id, startedAt: item.State.StartedAt };
  }
  result.secrets = JSON.parse(await docker(['secret', 'ls', '--format', '{{json .}}']).then(value => '[' + value.trim().split('\n').join(',') + ']')).map(row => ({ id: row.ID, name: row.Name })).sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
async function verify() {
  const state = await loadBusinessState(), preprod = await loadState();
  await assertBusinessResources(state);
  const before = { files: await privateSnapshot(), preprod: await preprodSnapshot(preprod), volumes: await Promise.all(businessVolumes.map(name => inspect('volume', name))) };
  const health = await fetch('http://127.0.0.1:8080/healthz').then(response => response.json());
  check('current business API is PostgreSQL-backed', health.database === 'postgres');
  const targets = await query('up'); report.metrics.targets = targets.map(row => ({ job: row.metric.job, environment: row.metric.environment ?? null, value: Number(row.value[1]) }));
  check('all six actual targets are up, with exactly one business API', targets.length === 6 && targets.every(row => row.value[1] === '1') && targets.filter(row => row.metric.job === 'bairui-api').length === 1);
  for (const metric of ['bairui_host_cpu_usage_ratio', 'bairui_host_memory_used_bytes', 'bairui_host_memory_total_bytes', 'bairui_runtime_controller_cycle_ok']) {
    const rows = await query(metric); check(metric + ' has real samples', rows.length > 0 && rows.every(row => Number.isFinite(Number(row.value[1]))));
    report.metrics[metric] = rows.map(row => ({ environment: row.metric.environment, value: Number(row.value[1]) }));
  }
  const oldRuntimeAlert = await alertRecords(preprod, 1000);
  const recoveredAt = before.preprod['bairui-runtime-business-controller'].startedAt;
  check('original Controller unavailability has a persisted resolution',
    hasPersistedResolution(oldRuntimeAlert, 'RuntimeControllerUnavailable', recoveredAt)
    && (await query('ALERTS{alertname="RuntimeControllerUnavailable",alertstate="firing"}')).length === 0);
  check('anonymous bridge and admin Grafana are rejected', (await fetch('http://127.0.0.1:9493/api/admin/grafana/api/user')).status === 401
    && (await fetch('http://localhost:5173/api/admin/grafana/api/user')).status === 401);
  const viewerHeaders = { ...headers, 'x-bairui-monitor-user': 'business-live-verification', 'x-bairui-monitor-role': 'Admin' };
  const user = await fetch('http://127.0.0.1:9493/api/admin/grafana/api/user', { headers: viewerHeaders }).then(response => response.json());
  const memberships = await fetch('http://127.0.0.1:9493/api/admin/grafana/api/user/orgs', { headers: viewerHeaders }).then(response => response.json());
  check('private Grafana identity stays Viewer', memberships.some(org => org.orgId === 1 && org.role === 'Viewer') && user.isGrafanaAdmin === false);
  if (faults) {
    const grafana = await inspect('container', businessNames.grafana); assertBusinessOwned(grafana.Config.Labels, state.installation);
    const cutoff = new Date().toISOString();
    try {
      await docker(['stop', '--time', '20', grafana.Id]);
      await waitUntil(async () => (await query('ALERTS{alertname="MonitoringTargetDown",alertstate="firing"}')).some(row => row.metric.environment === 'business'), 'business Grafana real firing', 150000);
      await waitUntil(async () => (await alertRecords(preprod, 1000)).some(row => row.receivedAt >= cutoff && row.alertname === 'MonitoringTargetDown' && row.status === 'firing' && row.instance === '127.0.0.1:9465'), 'business firing receiver record', 90000);
      check('real business Grafana failure is source-isolated and persisted by existing receiver', true);
    } finally {
      const current = await inspect('container', businessNames.grafana); assert.equal(current.Id, grafana.Id); assertBusinessOwned(current.Config.Labels, state.installation);
      if (!current.State.Running) await docker(['start', current.Id]);
    }
    await waitUntil(async () => (await query('up{job="grafana"}')).every(row => row.value[1] === '1'), 'business Grafana scrape recovery', 60000);
    await waitUntil(async () => (await alertRecords(preprod, 1000)).some(row => row.receivedAt >= cutoff && row.alertname === 'MonitoringTargetDown' && row.status === 'resolved' && row.instance === '127.0.0.1:9465'), 'business resolved receiver record', 150000);
    check('real business Grafana recovery is persisted', true);
    const history = await query('bairui_host_memory_total_bytes'); const oldSample = history[0];
    await withBusinessLock(async () => {
      await businessStop();
      try { await businessUp(); } catch (error) { await businessUp().catch(() => {}); throw error; }
    });
    const retained = await query('bairui_host_memory_total_bytes @ ' + oldSample.value[0]);
    check('stop/up preserves actual Prometheus history', retained.some(row => row.value[1] === oldSample.value[1]));
    const identity = await fetch('http://127.0.0.1:9493/api/admin/grafana/api/user/orgs', { headers: viewerHeaders }).then(response => response.json());
    check('stop/up preserves Viewer identity and Grafana data', identity.some(org => org.orgId === 1 && org.role === 'Viewer'));
  }
  assert.deepEqual(await privateSnapshot(), before.files); check('private configs, CA, tokens and state identities unchanged', true);
  assert.deepEqual(await preprodSnapshot(preprod), before.preprod); check('original preprod services and both Runtime installations not restarted', true);
  assert.deepEqual(await Promise.all(businessVolumes.map(name => inspect('volume', name))), before.volumes); check('business monitoring data volumes preserved', true);
  const counts = JSON.parse(await docker(['exec', 'bairui-postgres', 'psql', '-U', 'bairui', '-d', 'bairui', '-Atc', "SELECT json_build_object('users',(SELECT count(*) FROM users),'agents',(SELECT count(*) FROM agents),'resources',(SELECT count(*) FROM client_resources),'engineRuns',(SELECT count(*) FROM agent_engine_runs));"]));
  report.businessCounts = counts; assert.deepEqual(counts, { users: 6, agents: 6, resources: 4, engineRuns: 0 }); check('original business records remain 6 users / 6 Agents / 4 resources / 0 runs', true);
  report.success = true;
}
const directory = join(businessOutput, 'acceptance'); await mkdir(directory, { recursive: true });
await runWithKeepAlive(async () => {
  try { await verify(); }
  finally { const path = join(directory, 'live-' + report.startedAt.replace(/[:.]/g, '-') + '.json'); await writeFile(path, JSON.stringify(report, null, 2)); console.log('Evidence:', path); }
}).catch(error => { console.error(error.message); process.exitCode = 1; });
