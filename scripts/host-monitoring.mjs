import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, inspect, owned, containers, loadState, saveState, localDocker, withLock, waitUntil, root } from './preprod.mjs';
import { apiImage, label, assertOwned } from './preprod-config.mjs';
import { monitorNames, monitorServices } from './monitoring-config.mjs';
import { assertNativeHost, assertHostMountPrerequisites, assertHostRootReadonly, hostContainerArgs, hostComponentLabel, hostExporterImage, hostNames, hostReleaseLabel, hostReleaseRevision, hostCacheInitializationArgs } from './host-monitoring-config.mjs';
import { runWithKeepAlive } from './cli-keepalive.mjs';

export async function assertHostMonitoringResources(state, { inspectImpl = inspect } = {}) {
  assert.match(state.installation, /^[a-f0-9]{24}$/);
  const result = {};
  const network = await inspectImpl('network', monitorNames.network);
  assert.ok(network, 'host_metrics_monitoring_network_missing'); assertOwned(network.Labels, state.installation);
  assert.ok(network.Driver === 'overlay' && network.Attachable && network.Internal, 'host_metrics_private_network_required');
  for (const [kind, name] of Object.entries(hostNames)) {
    const type = kind === 'volume' ? 'volume' : 'container';
    const item = await inspectImpl(type, name); result[kind] = item;
    if (item) {
      const labels = type === 'container' ? item.Config?.Labels : item.Labels;
      assertOwned(labels, state.installation);
      assert.equal(labels?.[hostComponentLabel], kind === 'volume' ? 'cache' : kind, 'host_metrics_component_owner_mismatch');
    }
  }
  if (state.monitoring?.host?.resourcesReady) assert.ok(result.volume, 'host_metrics_cache_missing_restore_before_retry');
  return result;
}

async function nativeContext(state) {
  const local = await localDocker();
  assert.equal(local.nodeId, state.nodeId); assert.equal(local.endpoint, state.endpoint);
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
  assertNativeHost(process.platform, info);
  assertHostMountPrerequisites(info.KernelVersion, await readFile('/proc/self/mountinfo', 'utf8'));
}

export async function stopHostMonitoring(state) {
  if (!state.monitoring?.host?.resourcesReady) return;
  const resources = await assertHostMonitoringResources(state);
  for (const key of ['sampler', 'bridge', 'exporter']) if (resources[key]?.State.Running) await docker(['stop', '--time', '15', resources[key].Id]);
  state.monitoring.host.phase = 'stopped'; await saveState(state);
}

export function hostContainersCurrent(resources, release, input) {
  if (!input) return false;
  const commands = hostContainerArgs({ ...input, release });
  return ['exporter', 'sampler', 'bridge'].every(key => {
    const item = resources[key], config = item?.Config, host = item?.HostConfig;
    const image = key === 'exporter' ? hostExporterImage : apiImage(input.revision);
    if (!item?.State.Running || config?.Labels?.[hostReleaseLabel] !== release || config.Image !== image
      || config.User !== (key === 'exporter' ? '65534:65534' : '1000:1000')
      || JSON.stringify(config.Entrypoint) !== JSON.stringify([key === 'exporter' ? '/bin/node_exporter' : 'node'])
      || JSON.stringify(config.Cmd) !== JSON.stringify(commands[key].slice(commands[key].indexOf(image) + 1))
      || !host?.ReadonlyRootfs || host.Privileged || !host.CapDrop?.includes('ALL') || (host.CapAdd?.length ?? 0) > 0
      || host.Memory !== (key === 'exporter' ? 64 : 96) * 1024 ** 2 || host.NanoCpus !== (key === 'exporter' ? 200000000 : 150000000)
      || host.PidsLimit !== 64 || host.Init !== true || host.RestartPolicy?.Name !== 'unless-stopped'
      || !host.SecurityOpt?.includes('no-new-privileges:true') || Object.keys(host.PortBindings ?? {}).length || host.PublishAllPorts
      || host.NetworkMode !== (key === 'bridge' ? monitorNames.network : 'host') || (host.PidMode || '') !== (key === 'exporter' ? 'host' : '')) return false;
    const mounts = item.Mounts ?? [];
    if (key === 'exporter') return mounts.length === 1 && mounts[0].Type === 'bind' && mounts[0].Source === '/' && mounts[0].Destination === '/host' && mounts[0].RW === false && mounts[0].Propagation === 'rslave';
    const code = mounts.find(m => m.Destination === '/app/host-metrics-bridge.mjs'), data = mounts.find(m => m.Destination === '/data');
    return mounts.length === 2 && code?.Type === 'bind' && code.Source === input.sourcePath && code.RW === false
      && data?.Type === 'volume' && data.Name === hostNames.volume && data.RW === (key === 'sampler')
      && (key !== 'bridge' || Object.keys(item.NetworkSettings?.Networks ?? {}).join(',') === monitorNames.network);
  });
}

export function hostMonitoringCanPublish(state, services) {
  return state.phase === 'running' && state.monitoring?.enabled === true && state.monitoring.resourcesReady === true
    && state.monitoring.phase === 'running' && monitorServices.every(key => services[key]?.replicas === 1 && services[key]?.running === 1);
}

async function existingMonitoringRunning(state) {
  const services = {};
  for (const key of monitorServices) {
    const service = await owned('service', monitorNames[key], state);
    services[key] = { replicas: service?.Spec?.Mode?.Replicated?.Replicas, running: (await containers(monitorNames[key], state)).filter(row => row.State.Running).length };
  }
  return hostMonitoringCanPublish(state, services);
}

async function waitHostHealthy(state) {
  await waitUntil(async () => {
    try {
      const current = await assertHostMonitoringResources(state);
      if (!['exporter', 'sampler', 'bridge'].every(key => current[key]?.State.Running)) return false;
      await docker(['exec', current.bridge.Id, 'node', '-e', "fetch('http://127.0.0.1:9100/metrics',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { timeout: 5000 });
      return true;
    } catch { return false; }
  }, 'Linux host sampling', 60000);
}

async function verifyHostRoot(container) {
  assertHostRootReadonly(await docker(['exec', container, '/bin/cat', '/proc/self/mountinfo'], { timeout: 5000 }));
}

export async function startHostMonitoring(state, { recreate = false } = {}) {
  if (!state.monitoring?.host?.enabled) return;
  await nativeContext(state);
  assert.ok(state.phase === 'running' && state.monitoring.resourcesReady, 'install_preprod_monitoring_first');
  const resources = await assertHostMonitoringResources(state);
  const sourcePath = resolve(root, 'apps/platform-api/src/observability/host-metrics-bridge.mjs').replaceAll('\\', '/');
  await access(sourcePath);
  const input = { installation: state.installation, revision: state.revision, sourcePath };
  const release = hostReleaseRevision(input, await readFile(sourcePath, 'utf8'));
  if (!recreate && hostContainersCurrent(resources, release, input)) {
    try { await verifyHostRoot(resources.exporter.Id); await waitHostHealthy(state); }
    catch (error) { await stopHostMonitoring(state); state.monitoring.host.phase = 'failed'; await saveState(state); throw error; }
    state.monitoring.host.phase = 'running'; await saveState(state); return;
  }
  assert.ok(await owned('image', apiImage(state.revision), state), 'owned_platform_image_required');
  try { await docker(['image', 'inspect', hostExporterImage]); }
  catch (error) { if (!error.notFound) throw error; await docker(['pull', hostExporterImage], { timeout: 600000 }); }
  // Finish all ownership/platform/input preflight before stopping an existing installation.
  const commands = hostContainerArgs({ ...input, release });
  if (!resources.volume) {
    await docker(['volume', 'create', '--label', label + '=' + state.installation, '--label', hostComponentLabel + '=cache', hostNames.volume]);
  }
  for (const key of ['sampler', 'bridge', 'exporter']) if (resources[key]) {
    if (resources[key].State.Running) await docker(['stop', '--time', '15', resources[key].Id]);
    await docker(['rm', resources[key].Id]);
  }
  for (const command of hostCacheInitializationArgs(input)) await docker(command);
  state.monitoring.host.resourcesReady = true; state.monitoring.host.phase = 'starting'; state.monitoring.host.source = 'linux-host';
  await saveState(state);
  try {
    for (const key of ['exporter', 'sampler', 'bridge']) {
      await docker(commands[key]);
      if (key === 'exporter') await verifyHostRoot(hostNames.exporter);
    }
    await waitHostHealthy(state);
  } catch (error) {
    await stopHostMonitoring(state); state.monitoring.host.phase = 'failed'; await saveState(state); throw error;
  }
  state.monitoring.host.phase = 'running'; await saveState(state);
}

async function context() {
  const state = await loadState();
  assert.ok(state?.phase === 'running' && state.monitoring?.enabled && state.monitoring.resourcesReady, '先启动既有预发与监控。');
  const local = await localDocker(); assert.equal(local.nodeId, state.nodeId); assert.equal(local.endpoint, state.endpoint);
  return state;
}
async function main(command) {
  const state = await context();
  const { assertMonitoringResources, deployMonitoring } = await import('./monitoring.mjs');
  await assertMonitoringResources(state);
  if (command === 'up') {
    assert.ok(await existingMonitoringRunning(state), '既有监控未运行；主机采集命令不会自动唤起已停止的监控栈。');
    await nativeContext(state); await assertHostMonitoringResources(state);
    state.monitoring.host = { ...(state.monitoring.host ?? {}), enabled: true };
    await startHostMonitoring(state, { recreate: true });
    await deployMonitoring(state);
    console.log('Linux 整机采集已启用：管理端 → 运行监控 → 主机资源；无新公网端口。');
  } else if (command === 'stop') {
    const publish = await existingMonitoringRunning(state);
    await stopHostMonitoring(state);
    if (state.monitoring.host) { state.monitoring.host.enabled = false; await saveState(state); if (publish) await deployMonitoring(state); }
    console.log('主机采集已停止；指标历史、主机缓存卷及原监控数据保留。');
  } else if (command === 'status') {
    if (!state.monitoring.host?.resourcesReady) { console.log('整机采集未安装；没有用容器自身资源替代宿主机数据。'); return; }
    const resources = await assertHostMonitoringResources(state);
    console.log('来源：' + state.monitoring.host.source + ' | 记录状态：' + state.monitoring.host.phase);
    for (const key of ['exporter', 'sampler', 'bridge']) console.log(key + ': ' + (resources[key]?.State.Status ?? 'missing'));
    try {
      await docker(['exec', resources.bridge.Id, 'node', '-e', "fetch('http://127.0.0.1:9100/metrics',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { timeout: 5000 });
      console.log('样本：45 秒内有效');
    } catch { console.log('样本：不可用/已过期（不补零）'); }
  } else throw new Error('usage: npm run monitor:host -- up|status|stop');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWithKeepAlive(() => withLock(() => main(process.argv.length === 3 ? process.argv[2] : ''))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
