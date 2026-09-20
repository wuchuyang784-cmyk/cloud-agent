import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, localDocker, output } from './preprod.mjs';
import { monitoringAssets, monitorImages } from './monitoring-config.mjs';

export function ruleTests() {
  const up = (instance, values = '1+0x40') => ({ series: 'up{job="bairui-api",instance="' + instance + '"}', values });
  const ready = (instance, values = '1+0x40') => ({ series: 'bairui_database_ready{job="bairui-api",instance="' + instance + '"}', values });
  const infra = ['prometheus', 'alertmanager', 'grafana'].map(job => ({ series: 'up{job="' + job + '"}', values: '1+0x40' }));
  const alert = (alertname, exp_alerts) => ({ eval_time: '2m', alertname, exp_alerts });
  return {
    rule_files: ['/etc/bairui/rules.json'], evaluation_interval: '15s', tests: [
      { name: 'two_healthy_replicas', interval: '15s', input_series: [...infra, up('10.0.0.2:9464'), up('10.0.0.3:9464'), ready('10.0.0.2:9464'), ready('10.0.0.3:9464')],
        alert_rule_test: [alert('ApiReplicaMissing', []), alert('DatabaseUnavailable', []), alert('MonitoringTargetDown', [])] },
      { name: 'one_replica', interval: '15s', input_series: [...infra, up('10.0.0.2:9464'), ready('10.0.0.2:9464')],
        alert_rule_test: [alert('ApiReplicaMissing', [{ exp_labels: { severity: 'critical' }, exp_annotations: {} }])] },
      { name: 'zero_discovery_targets_is_not_healthy', interval: '15s', input_series: infra,
        alert_rule_test: [alert('ApiReplicaMissing', [{ exp_labels: { severity: 'critical' }, exp_annotations: {} }])] },
      { name: 'database_outage_is_separate_from_scrape', interval: '15s', input_series: [...infra, up('10.0.0.2:9464'), up('10.0.0.3:9464'), ready('10.0.0.2:9464', '0+0x40'), ready('10.0.0.3:9464')],
        alert_rule_test: [alert('ApiReplicaMissing', []), alert('DatabaseUnavailable', [{ exp_labels: { job: 'bairui-api', instance: '10.0.0.2:9464', severity: 'critical' }, exp_annotations: {} }])] },
      { name: 'missing_database_metric_is_not_healthy', interval: '15s', input_series: [...infra, up('10.0.0.2:9464')],
        alert_rule_test: [alert('DatabaseUnavailable', [{ exp_labels: { job: 'bairui-api', instance: '10.0.0.2:9464', severity: 'critical' }, exp_annotations: {} }])] },
      { name: 'recovered_replicas_resolve', interval: '15s', input_series: [...infra, up('10.0.0.2:9464'), up('10.0.0.3:9464', '0+0x5 1+0x34')],
        alert_rule_test: [alert('ApiReplicaMissing', [])] },
      { name: 'missing_monitor_target', interval: '15s', input_series: infra.filter(s => !s.series.includes('alertmanager')),
        alert_rule_test: [alert('MonitoringTargetDown', [{ exp_labels: { job: 'alertmanager', severity: 'critical' }, exp_annotations: {} }])] },
    ],
  };
}

export async function validateMonitoring() {
  await localDocker();
  const dir = join(output, 'monitoring-validation');
  const tokens = join(dir, 'test-secrets');
  await mkdir(tokens, { recursive: true });
  for (const [name, asset] of Object.entries(monitoringAssets())) await writeFile(join(dir, name), JSON.stringify(asset, null, 2));
  await writeFile(join(dir, 'rule-tests.json'), JSON.stringify(ruleTests(), null, 2));
  for (const name of ['metrics-token', 'alert-token']) await writeFile(join(tokens, name), 'validation-only-not-a-real-secret-00000000');
  const args = ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--mount', 'type=bind,source=' + dir + ',target=/etc/bairui,readonly', '--mount', 'type=bind,source=' + tokens + ',target=/run/secrets,readonly'];
  for (const [image, entrypoint, command] of [
    [monitorImages.prometheus, '/bin/promtool', ['check', 'config', '/etc/bairui/prometheus.json']],
    [monitorImages.prometheus, '/bin/promtool', ['test', 'rules', '/etc/bairui/rule-tests.json']],
    [monitorImages.alertmanager, '/bin/amtool', ['check-config', '/etc/bairui/alertmanager.json']],
  ]) {
    const text = await docker([...args, '--entrypoint', entrypoint, image, ...command], { timeout: 600000, logFile: join(dir, entrypoint.split('/').at(-1) + '-' + command[0] + '.log') });
    console.log(text);
  }
  console.log('官方配置检查和规则验收通过；未读取业务配置或部署服务。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await validateMonitoring().catch(error => { console.error(error.message); process.exitCode = 1; });
