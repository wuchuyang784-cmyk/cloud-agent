import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeNames, runtimeContainerArguments, controllerGrants } from './runtime-deployment-config.mjs';
import { readFile } from 'node:fs/promises';
import * as deployment from './runtime-deployment.mjs';
import { runtimeLabel } from './runtime-deployment-config.mjs';
import { label as preprodLabel, names, apiImage } from './preprod-config.mjs';
import { monitorNames } from './monitoring-config.mjs';
import * as preprodDeployment from './preprod.mjs';

const input = { environment: 'preprod', installation: 'a'.repeat(24), directory: 'E:/cloud-agent/output/runtime/preprod',
  apiImage: 'bairui/platform-api-preprod:' + 'b'.repeat(16), orchestratorImage: 'bairui/runtime-orchestrator:' + 'c'.repeat(16) };
test('managed deployment separates environments and pins private restartable containers', () => {
  assert.notEqual(runtimeNames('business').controller, runtimeNames('preprod').controller);
  for (const kind of ['controller', 'orchestrator']) {
    const args = runtimeContainerArguments(kind, input);
    assert.ok(args.includes('--restart=unless-stopped'));
    assert.ok(args.includes('--init'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--security-opt=no-new-privileges:true'));
    assert.ok(args.includes('--cap-drop=ALL'));
    assert.ok(!args.some(a => /^(--publish|-p|--privileged|--env-file)/.test(a)));
    assert.ok(!args.join(' ').includes('PASSWORD'));
    assert.ok(!args.join(' ').includes('DATABASE_URL'));
    assert.ok(args.includes(kind));
    assert.ok(args.includes('--label'));
    const socket = args.join(' ').includes('/var/run/docker.sock');
    assert.equal(socket, kind === 'orchestrator');
    assert.ok(args.includes(kind === 'controller' ? '--user=1000:1000' : '--user=0:0'));
  }
});
test('managed grants do not grant user control, tables or credential access', () => {
  const sql = controllerGrants();
  assert.ok(sql.includes('runtime_supervision_snapshot()'));
  assert.equal((sql.match(/runtime_control_|runtime_supervision_/g) ?? []).length, 9);
  assert.ok(!sql.match(/request_start|request_stop|ALL TABLES|BYPASSRLS|ba_session/));
});
test('deployment asset inputs reject ambiguous targets and path escapes', () => {
  assert.throws(() => runtimeNames('prod'));
  assert.throws(() => runtimeContainerArguments('api', input));
  assert.throws(() => runtimeContainerArguments('controller', { ...input, installation: 'invalid' }));
  assert.throws(() => runtimeContainerArguments('controller', { ...input, apiImage: 'node:latest' }));
});
test('rollout grants database CONNECT and checks installed runtime before preprod mutations', async () => {
  const deployment = await readFile(new URL('./runtime-deployment.mjs', import.meta.url), 'utf8');
  assert.match(deployment, /GRANT CONNECT ON DATABASE \$\{n\.database\} TO bairui_runtime_controller/);
  const preprod = await readFile(new URL('./preprod.mjs', import.meta.url), 'utf8');
  assert.ok(preprod.indexOf("assertRuntimeResources('preprod', state)") < preprod.indexOf('const rev = await revision(state)'));
  assert.ok(preprod.indexOf("stopRuntimeEnvironment('preprod')") < preprod.indexOf("'数据库停止'"));
});

// Simulate the Docker boundary only; the startup and safety decisions run unchanged.
function startupFixture({ environment = 'business', failures = 0, stateError = '', running = false,
  networkStartMissing = stateError === networkError } = {}) {
  const state = { environment, installation: input.installation, phase: 'ready' };
  const preprod = { installation: 'd'.repeat(24), revision: 'b'.repeat(16) };
  const n = runtimeNames(environment), records = new Map(), commands = [];
  for (const name of [n.control, n.network]) records.set('network:' + name, {
    Id: name + '-id', Labels: { [runtimeLabel]: state.installation }, Driver: 'bridge', Internal: true,
  });
  for (const name of [monitorNames.network, names.data]) records.set('network:' + name, {
    Id: name + '-id', Labels: { [preprodLabel]: preprod.installation }, Driver: 'overlay', Internal: true, Attachable: true,
  });
  records.set('secret:' + n.metricsSecret, { Spec: { Labels: {
    [runtimeLabel]: state.installation, [preprodLabel]: preprod.installation,
  } } });
  function container(id = 'e'.repeat(64)) {
    return { Id: id, Name: '/' + n.controller, Config: { Image: apiImage(preprod.revision), Labels: { [runtimeLabel]: state.installation } },
      HostConfig: { Init: true }, State: { Running: running, Status: running ? 'running' : 'exited', Error: stateError },
      NetworkSettings: { Networks: Object.fromEntries([n.control, ...(environment === 'preprod' ? [names.data] : []), monitorNames.network].map(name => [name, { NetworkID: name + '-id' }])) } };
  }
  records.set('container:' + n.controller, container());
  const files = new Map(['controller/controller.json', 'controller/metrics-token', 'controller/tls/cert.pem',
    'orchestrator/orchestrator.json', 'orchestrator/tls/key.pem', 'orchestrator/tls/cert.pem'].map(name => [name,
      Buffer.from(name.endsWith('.json') ? JSON.stringify({ BAIRUI_RUNTIME_DEPLOYMENT: environment, BAIRUI_RUNTIME_INSTALLATION: state.installation }) : 'existing-private-file')]));
  const deps = {
    inspectResource: async (kind, name) => structuredClone(records.get(kind + ':' + name) ?? null),
    readPrivate: async path => {
      const name = [...files.keys()].find(name => path.replaceAll('\\', '/').endsWith('/' + name));
      if (!name) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
      return files.get(name);
    },
    dockerCommand: async args => {
      commands.push(args);
      if (args[0] === 'start') {
        const current = records.get('container:' + n.controller);
        assert.equal(args[1], current.Id);
        if (failures-- > 0) {
          current.State = { Running: false, Status: 'exited', Error: stateError };
          throw Object.assign(new Error('Docker command failed'), { networkStartMissing });
        }
        current.State = { Running: true, Status: 'running', Error: '' };
      } else if (args[0] === 'rm') {
        assert.equal(args[1], records.get('container:' + n.controller).Id);
        assert.equal(args.length, 2);
        records.delete('container:' + n.controller);
      } else if (args[0] === 'create') {
        const created = container('f'.repeat(64));
        created.NetworkSettings.Networks = { [n.control]: { NetworkID: n.control + '-id' } };
        created.State = { Running: false, Status: 'created', Error: '' };
        records.set('container:' + n.controller, created);
      } else if (args[0] === 'network' && args[1] === 'connect') {
        records.get('container:' + n.controller).NetworkSettings.Networks[args[2]] = { NetworkID: args[2] + '-id' };
      } else throw new Error('unexpected mutating command: ' + args.slice(0, 2).join(' '));
    },
  };
  return { state, preprod, n, records, files, commands, deps };
}
const networkError = 'failed to set up container networking: network hmstwnjw2q91eymnftgbuhlwc not found';
async function startFixture(f) {
  assert.equal(typeof deployment.startRuntimeContainer, 'function', 'missing bounded runtime container startup');
  return deployment.startRuntimeContainer('controller', f.state,
    { preprod: f.preprod, orchImage: input.orchestratorImage }, f.deps);
}
test('healthy runtime container keeps its full ID and needs no restart or replacement', async () => {
  const f = startupFixture({ running: true });
  await startFixture(f);
  assert.equal(f.records.get('container:' + f.n.controller).Id, 'e'.repeat(64));
  assert.deepEqual(f.commands, []);
});
test('stopped runtime networking failure retries once before replacing the container', async () => {
  const f = startupFixture({ failures: 1, stateError: networkError });
  await startFixture(f);
  assert.deepEqual(f.commands.map(a => a[0]), ['start', 'start']);
  assert.equal(f.records.get('container:' + f.n.controller).Id, 'e'.repeat(64));
});
test('persistent startup networking failure replaces exactly one owned stopped container', async () => {
  const f = startupFixture({ failures: 2, stateError: networkError });
  await startFixture(f);
  assert.equal(f.records.get('container:' + f.n.controller).State.Running, true);
  assert.equal(f.commands.filter(a => a[0] === 'start').length, 3);
  assert.deepEqual(f.commands.filter(a => a[0] === 'rm'), [['rm', 'e'.repeat(64)]]);
  assert.equal(f.commands.filter(a => a[0] === 'create').length, 1);
  const replacement = f.records.get('container:' + f.n.controller);
  assert.ok(replacement.NetworkSettings.Networks[monitorNames.network]);
  assert.deepEqual(f.commands.filter(a => a.slice(0, 2).join(' ') === 'network connect'),
    [['network', 'connect', monitorNames.network, 'f'.repeat(64)]]);
  assert.ok(!f.commands.some(a => ['stop', 'volume', 'secret'].includes(a[0]) || a.slice(0, 2).join(' ') === 'network create'));
});
test('replacement networking failure terminates without another replacement', async () => {
  const f = startupFixture({ failures: 10, stateError: networkError });
  await assert.rejects(startFixture(f), /Docker command failed/);
  assert.equal(f.commands.filter(a => a[0] === 'start').length, 3);
  assert.equal(f.commands.filter(a => a[0] === 'rm').length, 1);
});
test('unrelated container errors cannot trigger retry or replacement', async () => {
  const f = startupFixture({ failures: 10, stateError: 'OCI runtime create failed: permission denied' });
  await assert.rejects(startFixture(f), /Docker command failed/);
  assert.deepEqual(f.commands.map(a => a[0]), ['start']);
});
for (const name of ['control', 'network', 'monitor']) test('missing persistent ' + name + ' network refuses all startup mutations', async () => {
  const f = startupFixture({ stateError: networkError });
  f.records.delete('network:' + (name === 'monitor' ? monitorNames.network : f.n[name]));
  await assert.rejects(startFixture(f), /runtime_.*network_missing/);
  assert.deepEqual(f.commands, []);
});
test('missing preprod data overlay refuses startup', async () => {
  const f = startupFixture({ environment: 'preprod' });
  f.records.delete('network:' + names.data);
  await assert.rejects(startFixture(f), /runtime_.*network_missing/);
  assert.deepEqual(f.commands, []);
});
test('wrong container installation refuses startup and replacement', async () => {
  const f = startupFixture({ stateError: networkError });
  f.records.get('container:' + f.n.controller).Config.Labels[runtimeLabel] = '0'.repeat(24);
  await assert.rejects(startFixture(f), /runtime_resource_owner_mismatch/);
  assert.deepEqual(f.commands, []);
});
test('wrong persistent network owner refuses startup', async () => {
  const f = startupFixture();
  f.records.get('network:' + monitorNames.network).Labels[preprodLabel] = '0'.repeat(24);
  await assert.rejects(startFixture(f), /runtime_resource_owner_mismatch/);
  assert.deepEqual(f.commands, []);
});
test('wrong metrics Secret installation refuses startup', async () => {
  const f = startupFixture();
  f.records.get('secret:' + f.n.metricsSecret).Spec.Labels[runtimeLabel] = '0'.repeat(24);
  await assert.rejects(startFixture(f), /runtime_resource_owner_mismatch/);
  assert.deepEqual(f.commands, []);
});
test('missing private TLS certificate refuses startup', async () => {
  const f = startupFixture(); f.files.delete('orchestrator/tls/cert.pem');
  await assert.rejects(startFixture(f), /runtime_private_config_missing/);
  assert.deepEqual(f.commands, []);
});
test('private config from another installation refuses startup', async () => {
  const f = startupFixture();
  f.files.set('controller/controller.json', Buffer.from(JSON.stringify({ BAIRUI_RUNTIME_DEPLOYMENT: 'business', BAIRUI_RUNTIME_INSTALLATION: '0'.repeat(24) })));
  await assert.rejects(startFixture(f), /runtime_private_config_invalid/);
  assert.deepEqual(f.commands, []);
});
test('networks are revalidated before destructive recovery', async () => {
  const f = startupFixture({ failures: 2, stateError: networkError });
  const command = f.deps.dockerCommand;
  f.deps.dockerCommand = async args => {
    try { return await command(args); }
    finally { if (f.commands.filter(a => a[0] === 'start').length === 2) f.records.delete('network:' + monitorNames.network); }
  };
  await assert.rejects(startFixture(f), /runtime_.*network_missing/);
  assert.equal(f.commands.filter(a => a[0] === 'rm').length, 0);
});
test('running container after rejected start is never removed for an old networking error', async () => {
  const f = startupFixture({ failures: 2, stateError: networkError });
  const command = f.deps.dockerCommand;
  f.deps.dockerCommand = async args => {
    try { return await command(args); }
    finally { if (args[0] === 'start') f.records.get('container:' + f.n.controller).State.Running = true; }
  };
  await assert.rejects(startFixture(f), /Docker command failed/);
  assert.deepEqual(f.commands.map(a => a[0]), ['start']);
});
test('container replacement by another actor refuses recovery of the new full ID', async () => {
  const f = startupFixture({ failures: 2, stateError: networkError });
  const command = f.deps.dockerCommand;
  f.deps.dockerCommand = async args => {
    try { return await command(args); }
    finally {
      if (f.commands.filter(a => a[0] === 'start').length === 2) f.records.get('container:' + f.n.controller).Id = '0'.repeat(64);
    }
  };
  await assert.rejects(startFixture(f), /runtime_container_changed/);
  assert.equal(f.commands.filter(a => a[0] === 'rm').length, 0);
});
test('misconfigured shared overlay refuses startup', async () => {
  const f = startupFixture(); f.records.get('network:' + monitorNames.network).Attachable = false;
  await assert.rejects(startFixture(f), /runtime_network_configuration_invalid/);
  assert.deepEqual(f.commands, []);
});
test('stopped networking error clears with normal start without replacement', async () => {
  const f = startupFixture({ stateError: networkError });
  await startFixture(f);
  assert.deepEqual(f.commands, [['start', 'e'.repeat(64)]]);
});
test('fresh container attaches existing networks before its first start', async () => {
  const f = startupFixture({ environment: 'preprod' }); f.records.delete('container:' + f.n.controller);
  await startFixture(f);
  assert.deepEqual(f.commands.map(a => a.slice(0, 2).join(' ')),
    ['create --pull=never', 'network connect', 'network connect', 'start ' + 'f'.repeat(64)]);
  const c = f.records.get('container:' + f.n.controller);
  assert.ok(c.NetworkSettings.Networks[names.data] && c.NetworkSettings.Networks[monitorNames.network]);
});
test('new container startup failure does not delete an untried replacement', async () => {
  const f = startupFixture({ failures: 10, stateError: networkError }); f.records.delete('container:' + f.n.controller);
  await assert.rejects(startFixture(f), /Docker command failed/);
  assert.equal(f.commands.filter(a => a[0] === 'start').length, 1);
  assert.equal(f.commands.filter(a => a[0] === 'rm').length, 0);
});
test('missing metrics Secret refuses all startup mutations', async () => {
  const f = startupFixture(); f.records.delete('secret:' + f.n.metricsSecret);
  await assert.rejects(startFixture(f), /runtime_metrics_secret_missing/);
  assert.deepEqual(f.commands, []);
});
test('invalid private JSON produces a fixed error without private contents', async () => {
  const f = startupFixture(); f.files.set('controller/controller.json', Buffer.from('PRIVATE-CREDENTIAL invalid JSON'));
  await assert.rejects(startFixture(f), error => error.message === 'runtime_private_config_invalid');
  assert.deepEqual(f.commands, []);
});
test('wrong ownership in the other role refuses startup before any mutation', async () => {
  const f = startupFixture();
  f.records.set('container:' + f.n.orchestrator, { Config: { Labels: { [runtimeLabel]: '0'.repeat(24) } } });
  await assert.rejects(startFixture(f), /runtime_resource_owner_mismatch/);
  assert.deepEqual(f.commands, []);
});
test('stale network error cannot authorize recovery of a current unrelated start failure', async () => {
  const f = startupFixture({ failures: 10, stateError: networkError, networkStartMissing: false });
  await assert.rejects(startFixture(f), /Docker command failed/);
  assert.deepEqual(f.commands.map(a => a[0]), ['start']);
});
test('unrelated retry failure cannot authorize recreation from stale networking state', async () => {
  const f = startupFixture({ failures: 10, stateError: networkError });
  const command = f.deps.dockerCommand;
  f.deps.dockerCommand = async args => {
    try { return await command(args); }
    catch (error) {
      if (f.commands.filter(a => a[0] === 'start').length === 2) error.networkStartMissing = false;
      throw error;
    }
  };
  await assert.rejects(startFixture(f), /Docker command failed/);
  assert.deepEqual(f.commands.map(a => a[0]), ['start', 'start']);
});
test('Docker failure metadata classifies only the current start stderr without exposing it', () => {
  assert.equal(typeof preprodDeployment.dockerCommandFailure, 'function');
  const stderr = 'Error response from daemon: ' + networkError + '\nPRIVATE-CREDENTIAL';
  const failure = preprodDeployment.dockerCommandFailure(['start', 'e'.repeat(64)], stderr);
  assert.equal(failure.networkStartMissing, true);
  assert.ok(!failure.message.includes('PRIVATE-CREDENTIAL'));
  assert.ok(!JSON.stringify(failure).includes('PRIVATE-CREDENTIAL'));
  assert.equal(failure.stderr, undefined);
  for (const args of [['create'], ['network', 'connect'], ['container', 'inspect']]) {
    assert.equal(preprodDeployment.dockerCommandFailure(args, stderr).networkStartMissing, false);
  }
  for (const stderr of ['OCI runtime create failed: permission denied', '', 'network already exists', 'network missing']) {
    assert.equal(preprodDeployment.dockerCommandFailure(['start', 'e'.repeat(64)], stderr).networkStartMissing, false);
  }
});
