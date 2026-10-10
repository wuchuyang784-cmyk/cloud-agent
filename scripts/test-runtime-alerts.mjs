import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeRules } from './runtime-monitoring-config.mjs';
import { createRuntimeTelemetry } from '../apps/platform-api/src/runtime/supervision/telemetry.mjs';
import { createAlertReceiver, readAlertRecords } from '../apps/platform-api/src/monitoring/alert-receiver.mjs';

const exec = promisify(execFile);
const job = 'bairui-runtime-controller';
const zero = { active: 0, stopping: 0, stopOverdue: 0, deadPending: 0, observationErrors: 0, observationStale: 0 };
const metricNames = ['controller_last_success_timestamp_seconds', 'controller_cycle_ok', 'active', 'stopping',
  'stop_overdue', 'dead_pending', 'observation_errors', 'observation_stale'];

export function runtimeRuleTests() {
  const names = runtimeRules().groups[0].rules.map(rule => rule.alert);
  const series = (name, values) => ({ series: `${name}{job="${job}",instance="host.docker.internal:9999"}`, values });
  const healthy = () => [series('up', '1+0x20'), ...metricNames.map(name => series('bairui_runtime_' + name,
    name === 'controller_last_success_timestamp_seconds' ? '0+15x20' : name === 'controller_cycle_ok' ? '1+0x20' : '0+0x20'))];
  const expect = (name, firing) => ({ alertname: name, eval_time: '2m', exp_alerts: firing ? [{ exp_labels: { severity: 'critical' }, exp_annotations: {} }] : [] });
  const scenario = (name, input_series, firing = []) => ({ name, interval: '15s', input_series,
    alert_rule_test: names.map(name => expect(name, firing.includes(name))) });
  const changed = (name, values) => healthy().map(item => item.series.startsWith(name + '{') ? { ...item, values } : item);
  return { rule_files: ['/etc/bairui/rules.json'], evaluation_interval: '15s', tests: [
    scenario('healthy_complete_snapshot', healthy()),
    scenario('missing_scrape_target', [], ['RuntimeControllerUnavailable']),
    scenario('target_down', changed('up', '0+0x20'), ['RuntimeControllerUnavailable']),
    scenario('last_success_stale', changed('bairui_runtime_controller_last_success_timestamp_seconds', '0+0x20'), ['RuntimeControllerUnavailable']),
    ...metricNames.map(name => scenario('missing_' + name, healthy().filter(item => !item.series.startsWith('bairui_runtime_' + name + '{')), ['RuntimeControllerUnavailable'])),
    scenario('cycle_failure', changed('bairui_runtime_controller_cycle_ok', '0+0x20'), ['RuntimeControllerCycleFailed']),
    scenario('overdue_stop', changed('bairui_runtime_stop_overdue', '1+0x20'), ['RuntimeStopOverdue']),
    scenario('dead_command', changed('bairui_runtime_dead_pending', '1+0x20'), ['RuntimeCommandDead']),
    scenario('observation_error', changed('bairui_runtime_observation_errors', '1+0x20'), ['RuntimeObservationUnavailable']),
    scenario('observation_stale', changed('bairui_runtime_observation_stale', '1+0x20'), ['RuntimeObservationUnavailable']),
    scenario('recovered_stop', changed('bairui_runtime_stop_overdue', '1+0x5 0+0x14')),
  ] };
}

export async function testRuntimeAlerts({ rulesOnly = false } = {}) {
  const installation = 'br-e3-alert-' + randomBytes(6).toString('hex');
  const owner = 'io.bairui.runtime-alert-test';
  const network = installation + '-net';
  const amName = installation + '-am';
  const promName = installation + '-prom';
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|POSTGRES_)/.test(key)) delete env[key];
  const cli = async args => (await exec('docker', args, { env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
  let directory, telemetry, receiver, refresh;
  let localVerified = false;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const until = async (description, predicate, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (interrupted) throw new Error('runtime_alert_test_interrupted');
      if (await predicate()) return;
      await delay(500);
    }
    throw new Error('runtime_alert_test_timeout_' + description);
  };
  try {
    const context = JSON.parse(await cli(['context', 'inspect']))[0];
    if (!/^(npipe:\/\/|unix:\/\/)/.test(context?.Endpoints?.docker?.Host ?? '') || env.DOCKER_HOST) throw new Error('local_docker_required');
    localVerified = true;
    const images = {};
    for (const [key, tag] of [['prom', 'prom/prometheus:v3.14.0'], ['am', 'prom/alertmanager:v0.34.1']]) {
      images[key] = JSON.parse(await cli(['image', 'inspect', tag]))[0].Id;
      assert.match(images[key], /^sha256:[a-f0-9]{64}$/);
    }
    directory = await mkdtemp(join(tmpdir(), 'bairui-e3-alert-'));
    const write = (name, value) => writeFile(join(directory, name), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o644 });
    await write('rules.json', runtimeRules());
    await write('rule-tests.json', runtimeRuleTests());
    const base = ['--pull=never', '--label', `${owner}=${installation}`, '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges:true', '--memory=256m', '--cpus=0.5', '--pids-limit=64',
      '--mount', `type=bind,source=${directory},target=/etc/bairui,readonly`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m'];
    const check = async (name, image, entrypoint, args) => cli(['run', '--rm', '--name', installation + '-' + name,
      ...base, '--network=none', '--entrypoint', entrypoint, image, ...args]);
    console.log(await check('rules', images.prom, '/bin/promtool', ['test', 'rules', '/etc/bairui/rule-tests.json']));
    console.log('E3 官方 promtool：18 场景、90 条告警断言通过（缺失/陈旧/异常/恢复）。');
    if (rulesOnly) return;

    const metricsToken = randomBytes(32).toString('hex');
    const alertToken = randomBytes(32).toString('hex');
    telemetry = createRuntimeTelemetry({ token: metricsToken, host: '0.0.0.0' });
    await telemetry.start();
    receiver = createAlertReceiver({ token: alertToken, directory: join(directory, 'receipts') });
    await new Promise((resolve, reject) => { receiver.once('error', reject); receiver.listen(0, '0.0.0.0', resolve); });
    await write('metrics-token', metricsToken); await write('alert-token', alertToken);
    await write('rules.json', runtimeRules({ duration: '2s', interval: '1s' }));
    await write('prometheus.json', {
      global: { scrape_interval: '1s', scrape_timeout: '900ms', evaluation_interval: '1s' },
      rule_files: ['/etc/bairui/rules.json'],
      alerting: { alertmanagers: [{ static_configs: [{ targets: [amName + ':9093'] }] }] },
      scrape_configs: [{ job_name: job, authorization: { type: 'Bearer', credentials_file: '/etc/bairui/metrics-token' },
        static_configs: [{ targets: ['host.docker.internal:' + telemetry.server.address().port] }], sample_limit: 100,
        label_limit: 8, label_value_length_limit: 128, body_size_limit: '64KB' }],
    });
    await write('alertmanager.json', {
      global: { resolve_timeout: '10s' },
      route: { receiver: 'isolated', group_by: ['alertname'], group_wait: '1s', group_interval: '1s', repeat_interval: '1h' },
      receivers: [{ name: 'isolated', webhook_configs: [{ url: `http://host.docker.internal:${receiver.address().port}/alerts`, send_resolved: true,
        max_alerts: 64, http_config: { authorization: { type: 'Bearer', credentials_file: '/etc/bairui/alert-token' } } }] }],
    });
    await check('prom-config', images.prom, '/bin/promtool', ['check', 'config', '/etc/bairui/prometheus.json']);
    await check('am-config', images.am, '/bin/amtool', ['check-config', '/etc/bairui/alertmanager.json']);
    // Docker Desktop internal networks cannot route to the native host fixtures.
    // This temporary bridge publishes no ports and joins no existing network.
    await cli(['network', 'create', '--label', `${owner}=${installation}`, network]);
    const running = [...base, '--network', network, '--add-host=host.docker.internal:host-gateway'];
    await cli(['run', '-d', '--name', amName, ...running, '--tmpfs', '/alertmanager:rw,noexec,nosuid,size=32m,uid=65534,gid=65534',
      images.am, '--config.file=/etc/bairui/alertmanager.json', '--storage.path=/alertmanager', '--cluster.listen-address=']);
    await cli(['run', '-d', '--name', promName, ...running, '--tmpfs', '/prometheus:rw,noexec,nosuid,size=64m,uid=65534,gid=65534',
      images.prom, '--config.file=/etc/bairui/prometheus.json', '--storage.tsdb.path=/prometheus', '--storage.tsdb.retention.time=1h']);
    const names = runtimeRules().groups[0].rules.map(rule => rule.alert);
    const received = async (expected, status, after = 0) => {
      const records = await readAlertRecords(join(directory, 'receipts'));
      assert.ok(records.every(record => record.instance === null), 'runtime alerts must aggregate identity labels');
      return expected.every(name => records.some(record => record.alertname === name && record.status === status && Date.parse(record.receivedAt) >= after));
    };
    // Test startup unknown through actual scrapes, rule evaluations and webhook writes.
    await until('startup_firing', () => received(names.slice(0, 2), 'firing'));
    console.log('E3 真实采集：启动无快照告警已持久记录。');
    let current = { ...zero };
    telemetry.update({ ok: true, snapshot: current });
    refresh = setInterval(() => telemetry.update({ ok: true, snapshot: current }), 500);
    await until('startup_resolved', () => received(names.slice(0, 2), 'resolved'));
    const faultTime = Date.now();
    current = { active: 1, stopping: 1, stopOverdue: 1, deadPending: 1, observationErrors: 1, observationStale: 1 };
    telemetry.update({ ok: true, snapshot: current });
    await until('resource_fault_firing', () => received(names.slice(2), 'firing', faultTime));
    const recoveryTime = Date.now();
    current = { ...zero };
    telemetry.update({ ok: true, snapshot: current });
    await until('resource_fault_resolved', () => received(names.slice(2), 'resolved', recoveryTime));
    clearInterval(refresh); refresh = undefined;
    const cycleFaultTime = Date.now();
    telemetry.update({ ok: false });
    await until('cycle_firing', () => received(['RuntimeControllerCycleFailed'], 'firing', cycleFaultTime));
    telemetry.update({ ok: true, snapshot: zero });
    await until('cycle_resolved', () => received(['RuntimeControllerCycleFailed'], 'resolved', cycleFaultTime));
    const outageTime = Date.now();
    const metricsPort = telemetry.server.address().port;
    await telemetry.close();
    await until('scrape_down', () => received(['RuntimeControllerUnavailable'], 'firing', outageTime));
    telemetry = createRuntimeTelemetry({ token: metricsToken, host: '0.0.0.0', port: metricsPort });
    telemetry.update({ ok: true, snapshot: zero });
    await telemetry.start();
    await until('scrape_recovered', () => received(['RuntimeControllerUnavailable'], 'resolved', outageTime));
    const records = await readAlertRecords(join(directory, 'receipts'));
    for (const name of names) for (const status of ['firing', 'resolved']) assert.ok(records.some(record => record.alertname === name && record.status === status));
    console.log(`E3 真实 Prometheus → Alertmanager → 接收器：5 类 firing/resolved、后续周期失败及采集中断/恢复通过；持久记录 ${records.length} 条。`);
  } finally {
    clearInterval(refresh);
    await telemetry?.close();
    if (receiver) await new Promise(resolve => { receiver.close(resolve); receiver.closeAllConnections(); });
    try {
      const ids = localVerified ? (await cli(['ps', '-a', '--no-trunc', '--filter', `label=${owner}=${installation}`, '--format', '{{.ID}}'])).split(/\s+/).filter(Boolean) : [];
      for (const id of ids) {
        assert.match(id, /^[a-f0-9]{64}$/);
        const info = JSON.parse(await cli(['inspect', id]))[0];
        assert.equal(info.Id, id); assert.equal(info.Config.Labels?.[owner], installation);
        await cli(['rm', '-f', '-v', id]);
      }
      const networks = localVerified ? (await cli(['network', 'ls', '--no-trunc', '--filter', `label=${owner}=${installation}`, '--format', '{{.ID}}'])).split(/\s+/).filter(Boolean) : [];
      for (const id of networks) {
        assert.match(id, /^[a-f0-9]{64}$/);
        const info = JSON.parse(await cli(['network', 'inspect', id]))[0];
        assert.equal(info.Id, id); assert.equal(info.Name, network); assert.equal(info.Labels?.[owner], installation);
        await cli(['network', 'rm', id]);
      }
      if (localVerified) console.log('E3 本次测试容器和网络已按完整 ID 与归属标签清理。');
    } catch { throw new Error('runtime_alert_cleanup_failed_' + installation); }
    finally {
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
      if (directory) {
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
        assert.ok(basename(directory).startsWith('bairui-e3-alert-'));
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await testRuntimeAlerts({ rulesOnly: process.argv.includes('--rules-only') }).catch(error => {
    console.error('E3 隔离告警验收失败：', error.code ?? error.message ?? error.name); process.exitCode = 1;
  });
}
