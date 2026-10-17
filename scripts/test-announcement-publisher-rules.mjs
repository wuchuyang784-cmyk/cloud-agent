import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { announcementMonitoringAssets } from './announcement-monitoring-config.mjs';

const exec = promisify(execFile);
const asset = announcementMonitoringAssets({ environment: 'business', targets: ['127.0.0.1:9496'] });
const names = asset.rules.groups[0].rules.map(rule => rule.alert);
const series = (metric, values) => ({ series: metric + '{job="bairui-announcement-publisher",bairui_environment="business",instance="127.0.0.1:9496"}', values });
const metricNames = ['cycle_ok', 'last_success_timestamp_seconds', 'pending', 'max_delay_seconds', 'blocked', 'failures_total'];
const healthy = () => [series('up', '1+0x30'), ...metricNames.map(name => series('bairui_announcement_publisher_' + name,
  name === 'last_success_timestamp_seconds' ? '0+15x30' : name === 'cycle_ok' ? '1+0x30' : '0+0x30'))];
const changed = (metric, values) => healthy().map(row => row.series.startsWith(metric + '{') ? { ...row, values } : row);
const scenario = (name, input_series, firing = []) => ({ name, interval: '15s', input_series,
  alert_rule_test: names.map(alertname => ({ alertname, eval_time: '3m', exp_alerts: firing.includes(alertname)
    ? [{ exp_labels: { severity: 'warning', bairui_environment: 'business' }, exp_annotations: {} }] : [] })) });
const tests = [scenario('healthy', healthy()), scenario('target_missing', [], ['AnnouncementPublisherUnavailable']),
  scenario('target_down', changed('up', '0+0x30'), ['AnnouncementPublisherUnavailable']),
  scenario('cycle_failed', changed('bairui_announcement_publisher_cycle_ok', '0+0x30'), ['AnnouncementPublisherCycleFailed']),
  scenario('heartbeat_stale', changed('bairui_announcement_publisher_last_success_timestamp_seconds', '0+0x30'), ['AnnouncementPublisherUnavailable']),
  scenario('delayed', changed('bairui_announcement_publisher_max_delay_seconds', '91+0x30'), ['AnnouncementPublishDelayed']),
  scenario('blocked', changed('bairui_announcement_publisher_blocked', '1+0x30'), ['AnnouncementPublishBlocked']),
  scenario('item_failed', changed('bairui_announcement_publisher_failures_total', '0+1x30'), ['AnnouncementPublishFailed']),
  ...metricNames.filter(name => name !== 'failures_total').map(name => scenario('missing_' + name, healthy().filter(row => !row.series.startsWith('bairui_announcement_publisher_' + name + '{')), ['AnnouncementPublisherUnavailable'])),
  scenario('recovered', changed('bairui_announcement_publisher_cycle_ok', '0+0x5 1+0x24'))];
let directory;
try {
  directory = await mkdtemp(join(tmpdir(), 'bairui-announcement-rules-'));
  await writeFile(join(directory, 'rules.json'), JSON.stringify(asset.rules));
  await writeFile(join(directory, 'tests.json'), JSON.stringify({ rule_files: ['/rules/rules.json'], evaluation_interval: '15s', tests }));
  await chmod(directory, 0o755);
  const context = JSON.parse((await exec('docker', ['context', 'inspect'], { windowsHide: true })).stdout)[0];
  assert.match(context?.Endpoints?.docker?.Host ?? '', /^(npipe:\/\/|unix:\/\/)/); assert.equal(process.env.DOCKER_HOST, undefined);
  const result = await exec('docker', ['run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--memory=256m', '--pids-limit=64', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--mount', 'type=bind,source=' + directory + ',target=/rules,readonly', '--entrypoint', '/bin/promtool',
    'prom/prometheus:v3.14.0', 'test', 'rules', '/rules/tests.json'], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  console.log(result.stdout); console.log('PASS announcement publisher official rules: ' + tests.length + ' scenarios / ' + tests.length * names.length + ' assertions.');
} catch (error) { console.error('announcement_publisher_rules_failed'); if (error.stdout) console.error(error.stdout); if (error.stderr) console.error(error.stderr); process.exitCode = 1; }
finally { if (directory) { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('bairui-announcement-rules-')); await rm(directory, { recursive: true, force: true }); } }
