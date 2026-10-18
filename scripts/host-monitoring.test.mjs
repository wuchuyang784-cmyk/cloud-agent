import test from 'node:test';
import assert from 'node:assert/strict';
import { hostNames, hostComponentLabel } from './host-monitoring-config.mjs';
import { hostContainerArgs, hostExporterImage } from './host-monitoring-config.mjs';
let api = {};
try { api = await import('./host-monitoring.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const state = { installation: 'a'.repeat(24), monitoring: { host: { resourcesReady: true } } };
function inspectFor({ foreign, missing, component, internal = true } = {}) {
  return async (kind, name) => {
    if (name === missing) return null;
    const key = Object.entries(hostNames).find(([, value]) => value === name)?.[0];
    const labels = { 'bairui.preprod.installation': name === foreign ? 'b'.repeat(24) : state.installation, [hostComponentLabel]: component ?? (key === 'volume' ? 'cache' : key) };
    return kind === 'network' ? { Driver: 'overlay', Internal: internal, Attachable: true, Labels: labels } : kind === 'container' ? { Config: { Labels: labels } } : { Labels: labels };
  };
}
test('all host monitoring resources are checked before any deployment mutation', async () => {
  assert.equal(typeof api.assertHostMonitoringResources, 'function');
  await assert.doesNotReject(api.assertHostMonitoringResources(state, { inspectImpl: inspectFor() }));
  for (const name of Object.values(hostNames)) {
    await assert.rejects(api.assertHostMonitoringResources(state, { inspectImpl: inspectFor({ foreign: name }) }));
  }
  await assert.rejects(api.assertHostMonitoringResources(state, { inspectImpl: inspectFor({ component: 'wrong' }) }));
});
test('initialized host cache missing or an externally reachable network fails closed', async () => {
  assert.equal(typeof api.assertHostMonitoringResources, 'function');
  await assert.rejects(api.assertHostMonitoringResources(state, { inspectImpl: inspectFor({ missing: hostNames.volume }) }));
  await assert.rejects(api.assertHostMonitoringResources(state, { inspectImpl: inspectFor({ internal: false }) }));
});
test('running containers are reusable only when all three belong to the expected release', () => {
  assert.equal(typeof api.hostContainersCurrent, 'function');
  const release = 'e'.repeat(64);
  const input = { installation: state.installation, revision: 'b'.repeat(16), sourcePath: '/srv/cloud-agent/host-metrics-bridge.mjs' };
  const commands = hostContainerArgs({ ...input, release });
  const resources = Object.fromEntries(['exporter', 'sampler', 'bridge'].map(key => {
    const image = key === 'exporter' ? hostExporterImage : 'bairui/platform-api-preprod:' + input.revision;
    const mounts = key === 'exporter' ? [{ Type: 'bind', Source: '/', Destination: '/host', RW: false, Propagation: 'rslave' }]
      : [{ Type: 'bind', Source: input.sourcePath, Destination: '/app/host-metrics-bridge.mjs', RW: false }, { Type: 'volume', Name: hostNames.volume, Destination: '/data', RW: key === 'sampler' }];
    return [key, { State: { Running: true }, Config: { Labels: { 'bairui.monitoring.host.revision': release }, Image: image, User: key === 'exporter' ? '65534:65534' : '1000:1000', Entrypoint: [key === 'exporter' ? '/bin/node_exporter' : 'node'], Cmd: commands[key].slice(commands[key].indexOf(image) + 1) },
      HostConfig: { NetworkMode: key === 'bridge' ? 'bairui-preprod-monitor' : 'host', PidMode: key === 'exporter' ? 'host' : '', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Privileged: false, PortBindings: {}, Memory: (key === 'exporter' ? 64 : 96) * 1024 ** 2, NanoCpus: key === 'exporter' ? 200000000 : 150000000, PidsLimit: 64, Init: true, RestartPolicy: { Name: 'unless-stopped' } }, Mounts: mounts,
      NetworkSettings: { Networks: key === 'bridge' ? { 'bairui-preprod-monitor': {} } : { host: {} } } }];
  }));
  assert.equal(api.hostContainersCurrent(resources, release, input), true);
  for (const key of ['exporter', 'sampler', 'bridge']) {
    const mismatch = structuredClone(resources); mismatch[key].Config.Labels['bairui.monitoring.host.revision'] = 'f'.repeat(64);
    assert.equal(api.hostContainersCurrent(mismatch, release, input), false);
  }
  for (const change of [r => { r.bridge.NetworkSettings.Networks.external = {}; }, r => { r.bridge.HostConfig.ReadonlyRootfs = false; }, r => { r.sampler.Config.Image = 'foreign'; }, r => { r.exporter.Config.Cmd = []; }, r => { r.bridge.Mounts[1].RW = true; }, r => { r.sampler.HostConfig.Memory = 0; }, r => { r.exporter.HostConfig.NanoCpus = 0; }, r => { r.bridge.HostConfig.PidsLimit = -1; }, r => { r.sampler.HostConfig.Init = false; }, r => { r.bridge.HostConfig.RestartPolicy.Name = 'always'; }]) {
    const drifted = structuredClone(resources); change(drifted); assert.equal(api.hostContainersCurrent(drifted, release, input), false, 'same release label cannot hide configuration drift');
  }
  resources.sampler.State.Running = false; assert.equal(api.hostContainersCurrent(resources, release, input), false);
});
test('host commands may publish config only when the existing monitor stack is actually running', () => {
  assert.equal(typeof api.hostMonitoringCanPublish, 'function');
  const active = { phase: 'running', monitoring: { enabled: true, resourcesReady: true, phase: 'running' } };
  const services = Object.fromEntries(['prometheus', 'grafana', 'alertmanager', 'receiver'].map(key => [key, { replicas: 1, running: 1 }]));
  assert.equal(api.hostMonitoringCanPublish(active, services), true);
  assert.equal(api.hostMonitoringCanPublish({ ...active, monitoring: { ...active.monitoring, phase: 'stopped' } }, services), false);
  services.grafana.replicas = 0; assert.equal(api.hostMonitoringCanPublish(active, services), false);
});
