import assert from 'node:assert/strict';
import { loadState, localDocker, owned, inspect, checkResources, docker, containers } from './preprod.mjs';
import { names, consolePublicOrigin, validateApiReplicas } from './preprod-config.mjs';
import { monitorNames, monitorServices, monitorVolumes } from './monitoring-config.mjs';
import { hostNames } from './host-monitoring-config.mjs';
import { runtimeNames, runtimeLabel } from './runtime-deployment-config.mjs';
import { loadRuntimeState } from './runtime-deployment.mjs';
import { businessKinds, businessNames, businessLabel } from './business-monitoring-config.mjs';
import { loadBusinessState, withBusinessLock, businessStop } from './business-monitoring.mjs';

export const logComponents = Object.freeze(['api', 'db', 'gateway', 'prometheus', 'grafana', 'alertmanager', 'receiver', 'exporter', 'sampler', 'host-bridge', 'controller', 'orchestrator']);

export function resourceDefinitions(state) {
  const services = { api: names.api, db: names.db };
  const standalone = { gateway: names.gateway };
  if (state?.monitoring?.resourcesReady) {
    for (const key of monitorServices) services[key] = monitorNames[key];
  }
  if (state?.monitoring?.host?.resourcesReady) Object.assign(standalone, { exporter: hostNames.exporter, sampler: hostNames.sampler, 'host-bridge': hostNames.bridge });
  const volumes = [names.volume, names.caddyVolume];
  if (state?.monitoring?.resourcesReady) volumes.push(...monitorVolumes);
  if (state?.monitoring?.host?.resourcesReady) volumes.push(hostNames.volume);
  return { services, standalone, volumes };
}

export async function deploymentContext({ load = loadState, local = localDocker, check = checkResources,
  find = owned, runtimeState = loadRuntimeState, inspectResource = inspect, command = docker,
  monitorCheck = async state => (await import('./monitoring.mjs')).assertMonitoringResources(state),
  runtimeCheck = async state => (await import('./runtime-deployment.mjs')).assertRuntimeResources('preprod', state) } = {}) {
  const state = await load(), machine = await local();
  if (!state) return { state: null, machine, services: {}, standalone: {}, volumes: [] };
  assert.equal(state.nodeId, machine.nodeId, 'deployment_node_mismatch');
  assert.equal(state.endpoint, machine.endpoint, 'deployment_endpoint_mismatch');
  validateApiReplicas(state.apiReplicas === undefined ? 1 : state.apiReplicas);
  await check(state);
  const definitions = resourceDefinitions(state), services = {}, standalone = {};
  for (const [key, name] of Object.entries(definitions.services)) services[key] = await find('service', name, state);
  for (const [key, name] of Object.entries(definitions.standalone)) standalone[key] = await find('container', name, state);
  const runtime = await runtimeState('preprod');
  if (runtime) {
    assert.equal(runtime.nodeId, machine.nodeId, 'runtime_node_mismatch');
    assert.equal(runtime.endpoint, machine.endpoint, 'runtime_endpoint_mismatch');
    if (state.runtime?.enabled) assert.equal(state.runtime.installation, runtime.installation, 'runtime_installation_mismatch');
    for (const key of ['controller', 'orchestrator']) {
      const item = await inspectResource('container', runtimeNames('preprod')[key]);
      if (item) assert.equal(item.Config?.Labels?.[runtimeLabel], runtime.installation, 'runtime_resource_owner_mismatch');
      standalone[key] = item;
    }
  } else if (state.runtime?.enabled) throw new Error('runtime_state_missing');
  for (const name of definitions.volumes) {
    const volume = await find('volume', name, state);
    if (state.phase !== 'initializing') assert.ok(volume, 'deployment_persistent_volume_missing:' + name);
  }
  if (state.monitoring?.enabled) await monitorCheck(state);
  if (state.runtime?.enabled) await runtimeCheck(state);
  const backupHelpers = (await command(['ps', '-aq', '--filter', 'label=bairui.deployment.backup=' + state.installation])).split(/\s+/).filter(Boolean);
  return { state, machine, services, standalone, volumes: definitions.volumes, runtime, backupHelpers };
}

export async function deploymentStatus(context, { output = console.log, command = docker, findContainers = containers } = {}) {
  if (!context.state) { output('尚未安装常驻预发；up 将沿用现有预发初始化流程。'); return; }
  const { state } = context;
  output('常驻预发：' + consolePublicOrigin(state.publicOrigin) + '/admin/ | API 目标 ' + (state.apiReplicas ?? 1) + ' | ' + state.phase);
  for (const [key, service] of Object.entries(context.services)) {
    const rows = service ? await findContainers(service.Spec.Name, state) : [];
    output(key + ': ' + rows.length + '/' + (service?.Spec?.Mode?.Replicated?.Replicas ?? 0)
      + ' | healthy=' + rows.filter(row => row.State.Health?.Status === 'healthy').length);
  }
  for (const [key, item] of Object.entries(context.standalone)) output(key + ': ' + (item?.State?.Status ?? 'absent'));
  if (context.backupHelpers?.length) output('检测到未回收的备份辅助容器：' + context.backupHelpers.length + '；up/update 会拒绝启动，请核对后清理。');
  const duplicate = await command(['ps', '--filter', 'name=^/bairui-business-monitor-', '--format', '{{.Names}}']);
  if (duplicate) output('另有业务监控正在运行；核对用途后可显式执行 consolidate business-monitoring。');
  output('监控=' + Boolean(state.monitoring?.enabled) + ' | 主机采集=' + Boolean(state.monitoring?.host?.enabled)
    + ' | Runtime=' + Boolean(state.runtime?.enabled) + '；真实 Agent 能力保持原配置。');
}

export async function deploymentLogs(context, { component = 'api', tail = 100 } = {}, { command = docker, output = console.log } = {}) {
  assert.ok(logComponents.includes(component), 'deployment_log_component_invalid');
  assert.ok(Number.isInteger(tail) && tail >= 1 && tail <= 1000, 'deployment_log_tail_invalid');
  const service = context.services[component], item = context.standalone[component];
  assert.ok(service || item, 'deployment_log_component_not_installed');
  const args = service ? ['service', 'logs', '--raw', '--timestamps', '--tail', String(tail), service.ID]
    : ['logs', '--timestamps', '--tail', String(tail), item.Id];
  output(await command(args, { includeStderr: true, timeout: 15000 }));
}

export async function consolidateBusinessMonitoring(context, overrides = {}) {
  const deps = { lock: withBusinessLock, load: loadBusinessState, inspect, stop: businessStop, report: console.log, ...overrides };
  await deps.lock(async () => {
    const state = await deps.load();
    if (!state) { deps.report('没有已登记的独立业务监控；未操作任何容器。'); return; }
    assert.equal(state.nodeId, context.machine.nodeId, 'business_node_mismatch');
    assert.equal(state.endpoint, context.machine.endpoint, 'business_endpoint_mismatch');
    // Validate every target before the first stop. No name-prefix batch deletion.
    for (const key of businessKinds) {
      const item = await deps.inspect('container', businessNames[key]);
      if (item) assert.equal(item.Config?.Labels?.[businessLabel], state.installation, 'business_resource_owner_mismatch');
    }
    await deps.stop();
    deps.report('仅停用独立业务监控。其历史、凭据、数据库及 business Runtime 均保留；此操作不迁移业务监控数据。');
  });
}
