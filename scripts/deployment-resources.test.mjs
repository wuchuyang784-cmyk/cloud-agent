import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentContext, deploymentLogs, resourceDefinitions, consolidateBusinessMonitoring } from './deployment-resources.mjs';
import { names } from './preprod-config.mjs';
import { monitorNames, monitorVolumes } from './monitoring-config.mjs';
import { stopRuntimeEnvironment } from './runtime-deployment.mjs';
import { businessLabel, businessNames } from './business-monitoring-config.mjs';

function fixture() {
  const calls = [];
  const state = { installation: 'a'.repeat(24), nodeId: 'node', endpoint: 'unix:///var/run/docker.sock' };
  const deps = { load: async () => state, local: async () => ({ nodeId: state.nodeId, endpoint: state.endpoint }),
    command: async () => '',
    check: async () => calls.push('check'), runtimeState: async () => null,
    inspectResource: async () => null,
    find: async (kind, name) => { calls.push([kind, name]); return { ID: 'owned-service-id', Id: 'owned-container-id' }; } };
  return { state, calls, deps };
}

test('Docker context/node changes are rejected before resource lookups', async () => {
  const f = fixture();
  f.deps.local = async () => ({ endpoint: 'ssh://other', nodeId: 'other' });
  await assert.rejects(deploymentContext(f.deps), /deployment_node_mismatch/);
  assert.deepEqual(f.calls, []);
});

test('initializing installs may retry their original up path before volumes exist', async () => {
  const f = fixture(); f.state.phase = 'initializing';
  f.deps.find = async () => null;
  const context = await deploymentContext(f.deps);
  assert.equal(context.state.phase, 'initializing');
});

test('enabled monitor resources are checked before an operation can stop Runtime', async () => {
  const f = fixture(); f.state.monitoring = { enabled: true, resourcesReady: true };
  f.deps.monitorCheck = async () => { throw new Error('missing_monitor_secret'); };
  await assert.rejects(deploymentContext(f.deps), /missing_monitor_secret/);
});

test('missing persistent volumes are not silently replaced', async () => {
  const f = fixture();
  const find = f.deps.find;
  f.deps.find = async (kind, name) => kind === 'volume' ? null : find(kind, name);
  await assert.rejects(deploymentContext(f.deps), /deployment_persistent_volume_missing/);
});

test('disabled but installed monitoring retains its resources in inventory and backups', async () => {
  const f = fixture();
  f.state.monitoring = { enabled: false, resourcesReady: true };
  const context = await deploymentContext(f.deps);
  assert.ok(context.services.grafana);
  assert.ok(monitorVolumes.every(name => context.volumes.includes(name)));
  assert.ok(!context.standalone.controller);
  assert.deepEqual(resourceDefinitions({}).volumes, [names.volume, names.caddyVolume]);
});

test('foreign runtime containers reject the complete operation before any log/stop/start', async () => {
  const f = fixture();
  f.deps.runtimeState = async () => ({ nodeId: f.state.nodeId, endpoint: f.state.endpoint, installation: 'b'.repeat(24) });
  f.deps.inspectResource = async () => ({ Config: { Labels: { 'bairui.runtime.installation': 'c'.repeat(24) } } });
  await assert.rejects(deploymentContext(f.deps), /runtime_resource_owner_mismatch/);
});

test('logs use the verified exact service/container ID and bounded lines', async () => {
  const commands = [], output = [];
  const deps = { command: async (args, options) => { commands.push({ args, options }); return 'log'; }, output: text => output.push(text) };
  const context = { services: { api: { ID: 'verified-service-id' } }, standalone: { gateway: { Id: 'verified-container-id' } } };
  await deploymentLogs(context, { component: 'api', tail: 20 }, deps);
  await deploymentLogs(context, { component: 'gateway', tail: 10 }, deps);
  assert.equal(commands[0].args.at(-1), 'verified-service-id');
  assert.equal(commands[1].args.at(-1), 'verified-container-id');
  assert.deepEqual(commands[0].args.slice(0, 2), ['service', 'logs']);
  assert.ok(commands.every(c => !c.args.includes('--follow') && c.options.timeout === 15000));
  await assert.rejects(deploymentLogs(context, { component: 'grafana' }, deps), /not_installed/);
  await assert.rejects(deploymentLogs(context, { component: monitorNames.grafana }, deps), /invalid/);
  assert.equal(commands.length, 2);
});

test('Runtime stop checks both owners before mutation and tolerates already absent components', async () => {
  const state = { nodeId: 'node', endpoint: 'unix:///var/run/docker.sock', running: true };
  const calls = [], deps = { load: async () => state, local: async () => ({ nodeId: state.nodeId, endpoint: state.endpoint }),
    find: async (_kind, name) => { calls.push(['inspect', name]); return name.endsWith('-controller') ? { Id: 'verified-controller-id', State: { Running: true } } : null; },
    command: async args => calls.push(args), persist: async () => calls.push(['save']) };
  await stopRuntimeEnvironment('preprod', deps);
  assert.equal(calls[0][0], 'inspect'); assert.equal(calls[1][0], 'inspect');
  assert.deepEqual(calls[2], ['stop', '--time', '30', 'verified-controller-id']);
  assert.equal(state.running, false);
  calls.length = 0;
  deps.find = async (_kind, name) => {
    if (name.endsWith('-orchestrator')) throw new Error('runtime_resource_owner_mismatch');
    return { Id: 'verified-controller-id', State: { Running: true } };
  };
  await assert.rejects(stopRuntimeEnvironment('preprod', deps), /owner_mismatch/);
  assert.deepEqual(calls, []);
  deps.local = async () => ({ nodeId: 'other', endpoint: 'ssh://other' });
  await assert.rejects(stopRuntimeEnvironment('preprod', deps), /runtime_node_mismatch/);
  assert.deepEqual(calls, []);
});

test('consolidation checks every business monitor owner and endpoint before stopping any component', async () => {
  const machine = { nodeId: 'node', endpoint: 'unix:///var/run/docker.sock' }, calls = [];
  const state = { ...machine, installation: 'a'.repeat(24) };
  const deps = { load: async () => state, lock: async fn => fn(), report: () => {},
    inspect: async (_kind, name) => { calls.push(name); return { Config: { Labels: { [businessLabel]: name === businessNames.caddy ? 'foreign' : state.installation } } }; },
    stop: async () => calls.push('stop') };
  await assert.rejects(consolidateBusinessMonitoring({ machine }, deps), /business_resource_owner_mismatch/);
  assert.ok(!calls.includes('stop'));
  calls.length = 0;
  deps.inspect = async (_kind, name) => { calls.push(name); return { Config: { Labels: { [businessLabel]: state.installation } } }; };
  await consolidateBusinessMonitoring({ machine }, deps);
  assert.equal(calls.at(-1), 'stop');
  assert.equal(calls.length, 4);
  calls.length = 0;
  await assert.rejects(consolidateBusinessMonitoring({ machine: { nodeId: 'other' } }, deps), /business_node_mismatch/);
  assert.deepEqual(calls, []);
});
