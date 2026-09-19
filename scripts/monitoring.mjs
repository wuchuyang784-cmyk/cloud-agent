import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, owned, loadState, saveState, localDocker, checkResources, output, withLock, up, containers, waitUntil, request } from './preprod.mjs';
import { label, names, apiImage } from './preprod-config.mjs';
import { monitoringStack, monitoringAssets, monitorNames, monitorVolumes, monitorSecrets, monitorServices, monitorImages, monitorConfigName, monitoringRevision, monitorOrigin } from './monitoring-config.mjs';
import { validateMonitoring } from './monitoring-rules.test.mjs';

// Monitoring shares the installation lock and never consumes the business .env.
export async function assertMonitoringResources(state, { requirePersistent = true } = {}) {
  const found = {};
  for (const [kind, resources] of Object.entries({ service: monitorServices.map(key => monitorNames[key]), network: [monitorNames.network], volume: monitorVolumes, secret: monitorSecrets,
    config: Object.keys(monitoringAssets()).map(monitorConfigName) })) {
    for (const name of resources) found[name] = await owned(kind, name, state);
  }
  const network = found[monitorNames.network];
  if (network && (network.Driver !== 'overlay' || !network.Attachable || !network.Internal)) throw new Error('monitoring_network_configuration_invalid');
  if (requirePersistent) {
    for (const name of [...monitorVolumes, ...monitorSecrets, monitorNames.network]) {
      if (!found[name]) throw new Error('监控持久资源缺失：' + name + '。不会创建替代卷或 Secret，请先确认恢复方案。');
    }
  }
  return found;
}

export async function ensureMonitoringResources(state) {
  const existing = await assertMonitoringResources(state, { requirePersistent: Boolean(state.monitoring?.resourcesReady) });
  if (state.monitoring?.resourcesReady) return;
  const secrets = monitorSecrets.map(name => existing[name]);
  if (!secrets.every(Boolean) && (secrets.some(Boolean) || state.monitoring?.secretsReady || monitorVolumes.some(name => existing[name]))) {
    throw new Error('监控 Secret 不完整，拒绝生成替代密码。请保留状态文件与现有资源后确认恢复方案。');
  }
  state.monitoring ??= { enabled: false, phase: 'initializing', resourcesReady: false, secretsReady: false };
  await saveState(state);
  if (!secrets.every(Boolean)) {
    for (const name of monitorSecrets) await docker(['secret', 'create', '--label', label + '=' + state.installation, name, '-'], { input: randomBytes(32).toString('hex') });
  }
  state.monitoring.secretsReady = true;
  await saveState(state);
  if (!existing[monitorNames.network]) await docker(['network', 'create', '--driver', 'overlay', '--attachable', '--internal', '--label', label + '=' + state.installation, monitorNames.network]);
  if (!await owned('image', apiImage(state.revision), state)) throw new Error('缺少本安装 API 镜像，请先运行 preprod:up。');
  const owners = [65534, 472, 65534, 1000];
  for (const [i, name] of monitorVolumes.entries()) {
    if (!existing[name]) await docker(['volume', 'create', '--label', label + '=' + state.installation, name]);
    // Retry interrupted initialization on owned volumes; only the root directory is changed.
    await docker(['run', '--rm', '--network', 'none', '--label', label + '=' + state.installation,
      '--user', '0:0', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges:true',
      '--mount', 'type=volume,source=' + name + ',target=/data', '--entrypoint', 'node', apiImage(state.revision),
      '-e', 'require("node:fs").chownSync("/data",' + owners[i] + ',' + owners[i] + ')']);
  }
  state.monitoring.resourcesReady = true;
  await saveState(state);
}

export async function deployMonitoring(state) {
  await assertMonitoringResources(state);
  for (const [name, asset] of Object.entries(monitoringAssets())) {
    const target = monitorConfigName(name);
    if (!await owned('config', target, state)) await docker(['config', 'create', '--label', label + '=' + state.installation, target, '-'], { input: JSON.stringify(asset) });
  }
  const path = join(output, 'monitoring-stack.json');
  await writeFile(path, JSON.stringify(monitoringStack(state), null, 2) + '\n');
  await docker(['stack', 'config', '--compose-file', path]);
  await docker(['stack', 'deploy', '--detach=true', '--resolve-image', 'never', '--compose-file', path, monitorNames.stack]);
  await waitUntil(async () => {
    for (const key of monitorServices) {
      const rows = await containers(monitorNames[key], state);
      if (rows.length !== 1 || rows[0].State.Health?.Status !== 'healthy') return false;
    }
    return true;
  }, '四项监控服务启动', 240000);
  const health = await request(monitorOrigin + '/api/health');
  if (health.status !== 200 || JSON.parse(health.text).database !== 'ok') throw new Error('Grafana HTTPS 健康检查失败。');
  state.monitoring.phase = 'running'; state.monitoring.revision = monitoringRevision();
  await saveState(state);
}

async function context() {
  const state = await loadState();
  if (!state || !state.revision || state.phase === 'initializing') throw new Error('请先完成 npm run preprod:up。');
  const local = await localDocker();
  if (local.nodeId !== state.nodeId || local.endpoint !== state.endpoint) throw new Error('当前 Docker 不是记录的预发节点。');
  await checkResources(state);
  for (const name of [names.volume, names.caddyVolume]) if (!await owned('volume', name, state)) throw new Error('预发持久卷缺失：' + name);
  return state;
}

export async function monitorUp() {
  const state = await context();
  await assertMonitoringResources(state, { requirePersistent: Boolean(state.monitoring?.resourcesReady) });
  for (const image of Object.values(monitorImages)) {
    console.log('准备固定监控镜像：' + image);
    await docker(['pull', image], { timeout: 600000, logFile: join(output, 'pull-' + image.split('/')[1].replace(':', '-') + '.log') });
  }
  await validateMonitoring();
  await ensureMonitoringResources(state);
  state.monitoring.enabled = true;
  await saveState(state);
  console.log('接入监控会重建仅预发的 Caddy 和 API，入口短暂中断；数据库与既有 Secret 保留。');
  await up();
  console.log('监控已就绪：' + monitorOrigin + '。账号 admin；显式运行 npm run monitor:password 复制独立密码。');
}

export async function stopMonitoringServices(state) {
  await assertMonitoringResources(state);
  for (const key of monitorServices) if (await owned('service', monitorNames[key], state)) await docker(['service', 'scale', '--detach=true', monitorNames[key] + '=0']);
  await waitUntil(async () => {
    for (const key of monitorServices) if ((await containers(monitorNames[key], state)).length) return false;
    return true;
  }, '监控停止');
  state.monitoring.phase = 'stopped';
  await saveState(state);
}

async function monitorStop() {
  const state = await context();
  if (!state.monitoring?.resourcesReady) { console.log('尚未安装监控。'); return; }
  await stopMonitoringServices(state);
  console.log('监控采集、看板和告警已停止；平台仍运行，数据及 Secret 保留。monitor:up 或 preprod:up 将恢复监控。');
}

async function monitorStatus() {
  const state = await context();
  if (!state.monitoring?.resourcesReady) { console.log('尚未安装监控。运行 npm run monitor:up。'); return; }
  await assertMonitoringResources(state);
  console.log('监控：' + monitorOrigin + ' | 记录状态：' + state.monitoring.phase);
  for (const key of monitorServices) {
    const rows = await containers(monitorNames[key], state);
    console.log(key + '：运行 ' + rows.length + '，健康 ' + rows.filter(row => row.State.Health?.Status === 'healthy').length);
  }
  console.log('通知仅保存在本机。整机停机时无法自行发出告警；无外部邮件或企业微信通知。');
}

export async function alertRecords(state, limit = 100) {
  assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 1000);
  await assertMonitoringResources(state);
  const rows = await containers(monitorNames.receiver, state);
  if (rows.length !== 1) throw new Error('告警接收器未运行；先运行 monitor:up，既有记录仍保存在持久卷。');
  const code = 'const {readAlertRecords}=await import("./src/monitoring/alert-receiver.mjs");console.log(JSON.stringify(await readAlertRecords("/data",' + limit + ')));';
  return JSON.parse(await docker(['exec', rows[0].Id, 'node', '--input-type=module', '-e', code]));
}

async function monitorAlerts() {
  const records = await alertRecords(await context());
  if (!records.length) console.log('当前没有本地告警记录。');
  else console.table(records);
}

export async function grafanaPassword(state) {
  await assertMonitoringResources(state);
  const rows = await containers(monitorNames.grafana, state);
  if (rows.length !== 1) throw new Error('Grafana 未运行；先运行 monitor:up。');
  const secret = await docker(['exec', rows[0].Id, 'cat', '/run/secrets/grafana-password']);
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Grafana 凭据格式不符合本安装约定。');
  return secret;
}

async function monitorPassword() {
  if (process.platform !== 'win32') throw new Error('本命令仅支持 Windows 剪贴板，不会输出密码。');
  const password = await grafanaPassword(await context());
  await new Promise((done, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::In.ReadToEnd() | Set-Clipboard'],
      { windowsHide: true, timeout: 15000 }, error => error ? reject(new Error('无法写入本机剪贴板。')) : done());
    child.stdin.on('error', () => {}); child.stdin.end(password);
  });
  console.log('Grafana 独立管理员密码已复制到本机剪贴板，未输出到终端。用户名：admin。使用后请清空剪贴板。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = { up: monitorUp, status: monitorStatus, stop: monitorStop, alerts: monitorAlerts, password: monitorPassword }[process.argv[2]];
  if (!action) { console.error('用法：node scripts/monitoring.mjs up|status|stop|alerts|password'); process.exitCode = 1; }
  else await withLock(action).catch(error => { console.error(error.message); process.exitCode = 1; });
}
