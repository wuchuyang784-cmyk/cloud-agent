import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { businessNames, businessKinds, businessVolumes, businessLabel, businessAssets } from './business-monitoring-config.mjs';
const module = await import('./business-monitoring.mjs').catch(() => ({}));
const installation = 'a'.repeat(24);

function fixture() {
  const state = { version: 1, installation, phase: 'running', endpoint: 'npipe:////./pipe/docker_engine', nodeId: 'node-local', credentialsReady: true, assetsReady: true, resourcesReady: true, revision: 'b'.repeat(16) };
  const records = new Map(), commands = [];
  for (const name of businessVolumes) records.set('volume:' + name, { Labels: { [businessLabel]: installation } });
  records.set('network:' + businessNames.network, { Labels: { [businessLabel]: installation }, Driver: 'bridge', Internal: false });
  for (const kind of businessKinds) records.set('container:' + businessNames[kind], { Id: kind + '-id', Config: { Labels: { [businessLabel]: installation, 'bairui.business-monitoring.revision': state.revision }, Env: ['GF_AUTH_PROXY_WHITELIST=172.28.0.3'] }, State: { Running: true } });
  const deps = { directory: 'E:/cloud-agent/output/business-monitoring',
    inspect: async (kind, name) => records.get(kind + ':' + name) ?? null,
    readFile: async path => {
      if (path.endsWith('bridge-token') || path.endsWith('metrics-token') || path.endsWith('grafana-password')) return 'c'.repeat(64);
      if (path.endsWith('connector.json')) return JSON.stringify({ version: 1, installation, upstreamUrl: 'http://127.0.0.1:9493', publicOrigin: 'http://localhost:5173', metricsPort: 9465, bridgeTokenFile: 'E:\\cloud-agent\\output\\business-monitoring\\bridge-token', metricsTokenFile: 'E:\\cloud-agent\\output\\business-monitoring\\metrics-token' });
      return '{}';
    },
    docker: async args => { commands.push(args); return ''; }, save: async () => {},
  };
  return { state, records, commands, deps };
}

test('resource preflight checks all owners before any mutation', async () => {
  assert.equal(typeof module.assertBusinessResources, 'function', 'business monitoring CLI is missing');
  const f = fixture();
  f.records.get('container:' + businessNames.caddy).Config.Labels[businessLabel] = 'd'.repeat(24);
  await assert.rejects(module.assertBusinessResources(f.state, f.deps), /business_resource_owner_mismatch/);
  assert.equal(f.commands.length, 0);
});

test('installed missing persistent volume is refused without replacement', async () => {
  assert.equal(typeof module.ensureBusinessResources, 'function');
  const f = fixture(); f.records.delete('volume:' + businessNames.promVolume);
  await assert.rejects(module.ensureBusinessResources(f.state, f.deps), /business_persistent_resource_missing/);
  assert.equal(f.commands.length, 0);
});

test('installed credential and generated asset loss are refused', async () => {
  assert.equal(typeof module.assertBusinessResources, 'function');
  for (const missing of ['bridge-token', 'metrics-token', 'grafana-password', 'connector.json', 'prometheus.json', 'caddy.json']) {
    const f = fixture(), read = f.deps.readFile;
    f.deps.readFile = async path => { if (path.endsWith(missing)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return read(path); };
    await assert.rejects(module.assertBusinessResources(f.state, f.deps), /business_private_file_missing/);
    assert.equal(f.commands.length, 0);
  }
});

test('installed bridge must remain dedicated outbound-capable bridge', async () => {
  assert.equal(typeof module.assertBusinessResources, 'function');
  for (const change of [{ Driver: 'overlay' }, { Internal: true }]) {
    const f = fixture(); Object.assign(f.records.get('network:' + businessNames.network), change);
    await assert.rejects(module.assertBusinessResources(f.state, f.deps), /business_network_configuration_invalid/);
  }
});

test('stop affects only owned business containers and preserves network volumes and private files', async () => {
  assert.equal(typeof module.stopBusinessMonitoring, 'function');
  const f = fixture(); await module.stopBusinessMonitoring(f.state, f.deps);
  assert.deepEqual(f.commands, businessKinds.map(kind => ['stop', '--time', '20', kind + '-id']));
  assert.equal(f.state.phase, 'stopped');
  assert.equal(f.state.resourcesReady, true);
  assert.equal(f.records.get('volume:' + businessNames.promVolume).Labels[businessLabel], installation);
});

test('stop rejects later conflicting ownership before stopping earlier containers', async () => {
  assert.equal(typeof module.stopBusinessMonitoring, 'function');
  const f = fixture(); f.records.get('container:' + businessNames.caddy).Config.Labels[businessLabel] = 'd'.repeat(24);
  await assert.rejects(module.stopBusinessMonitoring(f.state, f.deps), /business_resource_owner_mismatch/);
  assert.equal(f.commands.length, 0);
});

test('reconcile starts matching stopped container and does not replace data', async () => {
  assert.equal(typeof module.reconcileBusinessContainer, 'function');
  const f = fixture(); f.records.get('container:' + businessNames.prometheus).State.Running = false;
  await module.reconcileBusinessContainer('prometheus', f.state, { revision: f.state.revision }, f.deps);
  assert.deepEqual(f.commands, [['start', 'prometheus-id']]);
});

test('reconcile replaces only owned changed container by full id', async () => {
  assert.equal(typeof module.reconcileBusinessContainer, 'function');
  const f = fixture();
  await module.reconcileBusinessContainer('caddy', f.state, { revision: 'e'.repeat(16) }, f.deps);
  assert.deepEqual(f.commands[0], ['stop', '--time', '20', 'caddy-id']);
  assert.deepEqual(f.commands[1], ['rm', 'caddy-id']);
  assert.equal(f.commands[2][0], 'run');
  assert.ok(f.commands[2].includes(businessNames.caddy));
});

test('Grafana is replaced when live bridge IP changes even when asset revision matches', async () => {
  assert.equal(typeof module.reconcileBusinessContainer, 'function');
  const f = fixture();
  await module.reconcileBusinessContainer('grafana', f.state, { revision: f.state.revision, gatewayIp: '172.28.0.9' }, f.deps);
  assert.deepEqual(f.commands[1], ['rm', 'grafana-id']);
  assert.ok(f.commands[2].includes('GF_AUTH_PROXY_WHITELIST=172.28.0.9'));
});

test('shared preprod and runtime validation is read only and refuses wrong owners', async () => {
  assert.equal(typeof module.assertSharedMonitoring, 'function');
  const f = fixture(), preprod = { installation: 'd'.repeat(24), endpoint: f.state.endpoint, nodeId: f.state.nodeId };
  const runtimes = Object.fromEntries(['business', 'preprod'].map(environment => [environment, { version: 1, environment, installation: (environment === 'business' ? 'e' : 'f').repeat(24), phase: 'ready', endpoint: f.state.endpoint, nodeId: f.state.nodeId }]));
  const { monitorNames } = await import('./monitoring-config.mjs');
  const { label } = await import('./preprod-config.mjs');
  const { runtimeNames, runtimeLabel } = await import('./runtime-deployment-config.mjs');
  f.records.set('network:' + monitorNames.network, { Labels: { [label]: preprod.installation }, Driver: 'overlay', Attachable: true, Internal: true });
  f.records.set('service:' + monitorNames.alertmanager, { Spec: { Labels: { [label]: preprod.installation } } });
  for (const environment of ['business', 'preprod']) f.records.set('container:' + runtimeNames(environment).controller, { Config: { Labels: { [runtimeLabel]: runtimes[environment].installation } }, NetworkSettings: { Networks: { [monitorNames.network]: {} } } });
  const result = await module.assertSharedMonitoring(preprod, runtimes, f.deps);
  assert.equal(Object.keys(result).length, 2); assert.equal(f.commands.length, 0);
  f.records.get('container:' + runtimeNames('business').controller).Config.Labels[runtimeLabel] = '1'.repeat(24);
  await assert.rejects(module.assertSharedMonitoring(preprod, runtimes, f.deps), /business_runtime_owner_mismatch/);
  assert.equal(f.commands.length, 0);
});

test('new install refuses any unrecorded resource before adopting or creating', async () => {
  assert.equal(typeof module.assertBusinessResources, 'function');
  const f = fixture();
  await assert.rejects(module.assertBusinessResources(null, f.deps), /business_unrecorded_resource/);
  assert.equal(f.commands.length, 0);
});

test('all generated assets are required for completed installations', async () => {
  assert.equal(typeof module.assertBusinessResources, 'function');
  const f = fixture(), paths = [];
  const read = f.deps.readFile; f.deps.readFile = async path => { paths.push(path.replaceAll('\\', '/')); return read(path); };
  await module.assertBusinessResources(f.state, f.deps);
  for (const name of Object.keys(businessAssets())) assert.ok(paths.some(p => p.endsWith('/' + name)));
});

test('installed connector cannot silently point at another installation or token file', async () => {
  for (const change of [{ installation: 'd'.repeat(24) }, { bridgeTokenFile: 'E:/other/token' }, { upstreamUrl: 'http://evil.test' }, { extra: 'untrusted' }]) {
    const f = fixture(), read = f.deps.readFile;
    f.deps.readFile = async path => {
      const value = await read(path); return path.endsWith('connector.json') ? JSON.stringify({ ...JSON.parse(value), ...change }) : value;
    };
    await assert.rejects(module.assertBusinessResources(f.state, f.deps), /business_connector_invalid/);
    assert.equal(f.commands.length, 0);
  }
});

test('credentials are bounded machine tokens and never recreated from invalid files', async () => {
  const f = fixture(), read = f.deps.readFile;
  f.deps.readFile = async path => path.endsWith('metrics-token') ? 'short' : read(path);
  await assert.rejects(module.ensureBusinessResources(f.state, f.deps), /business_credential_invalid/);
  assert.equal(f.commands.length, 0);
});

test('running state cannot disable persistence checks and replace lost history', async () => {
  const f = fixture(); f.state.resourcesReady = false; f.records.delete('volume:' + businessNames.promVolume);
  await assert.rejects(module.ensureBusinessResources(f.state, f.deps), /business_state_invalid/);
  assert.equal(f.commands.length, 0);
});

async function assetFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bairui-business-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = [...Object.keys(businessAssets()), 'caddy.json', 'connector.json'];
  for (const name of names) await writeFile(join(directory, name), 'installed:' + name);
  for (const name of ['bridge-token', 'metrics-token', 'grafana-password']) await writeFile(join(directory, name), 'c'.repeat(64));
  const state = fixture().state;
  const runtimeTokenFiles = { business: join(directory, 'runtime-business-token'), preprod: join(directory, 'runtime-preprod-token') };
  return { directory, names, state, runtimeTokenFiles };
}

test('rejected staged assets leave every installed file and reconciliation state untouched', async t => {
  const f = await assetFixture(t);
  assert.equal(typeof module.writeAssets, 'function');
  await assert.rejects(module.writeAssets(f.state, f.runtimeTokenFiles, { directory: f.directory, save: async () => {}, docker: async args => {
    for (const name of f.names) assert.equal(await readFile(join(f.directory, name), 'utf8'), 'installed:' + name);
    assert.ok(args.some(arg => arg.includes('.assets-')), 'validator must read staged files');
    throw new Error('validator_rejected');
  } }), /validator_rejected/);
  for (const name of f.names) assert.equal(await readFile(join(f.directory, name), 'utf8'), 'installed:' + name);
  assert.equal(f.state.assetsPendingReconcile, undefined);
  assert.ok(!(await readdir(f.directory)).some(name => name.startsWith('.assets-')));
});

test('validated assets publish by replacement and unchanged assets retain their mounted inode', async t => {
  const f = await assetFixture(t), commands = [];
  assert.equal(typeof module.writeAssets, 'function');
  const held = await open(join(f.directory, 'dashboard.json'), 'r');
  t.after(() => held.close());
  const old = await stat(join(f.directory, 'dashboard.json'));
  const deps = { directory: f.directory, save: async () => {}, docker: async args => {
    commands.push(args);
    for (const name of f.names) assert.equal(await readFile(join(f.directory, name), 'utf8'), 'installed:' + name);
  }, beforePublish: async () => {
    assert.equal(commands.length, 3, 'all validators finish before releasing installed mounts');
    assert.equal(await held.readFile('utf8'), 'installed:dashboard.json', 'live mounted inode must never be truncated');
    await held.close();
  } };
  await module.writeAssets(f.state, f.runtimeTokenFiles, deps);
  assert.equal(commands.length, 3);
  assert.notEqual((await stat(join(f.directory, 'dashboard.json'))).ino, old.ino);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'dashboard.json'), 'utf8')).uid, 'bairui-platform');
  assert.equal(await readFile(join(f.directory, 'metrics-token'), 'utf8'), 'c'.repeat(64));
  assert.equal(f.state.assetsPendingReconcile, true);
  const before = await stat(join(f.directory, 'dashboard.json'));
  await module.writeAssets(f.state, f.runtimeTokenFiles, { ...deps, docker: async () => {} });
  const after = await stat(join(f.directory, 'dashboard.json'));
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(f.state.assetsPendingReconcile, true, 'interrupted reconciliation remains pending even when files now match');
  assert.ok(!(await readdir(f.directory)).some(name => name.startsWith('.assets-')));
});

test('published asset replacement recreates matching containers so their bind mounts use new files', async () => {
  const f = fixture();
  await module.reconcileBusinessContainer('prometheus', f.state, { revision: f.state.revision, assetsChanged: true }, f.deps);
  assert.deepEqual(f.commands[0], ['stop', '--time', '20', 'prometheus-id']);
  assert.deepEqual(f.commands[1], ['rm', 'prometheus-id']);
  assert.equal(f.commands[2][0], 'run');
});

test('publication checks every container owner before quiescing and uses only owned full ids', async t => {
  for (const conflict of [false, true]) {
    const f = await assetFixture(t), resources = fixture(), commands = [];
    if (conflict) resources.records.get('container:' + businessNames.caddy).Config.Labels[businessLabel] = 'd'.repeat(24);
    const action = module.writeAssets(f.state, f.runtimeTokenFiles, { directory: f.directory, inspect: resources.deps.inspect,
      save: async () => {}, docker: async args => {
        for (const name of f.names) assert.equal(await readFile(join(f.directory, name), 'utf8'), 'installed:' + name);
        commands.push(args);
      } });
    if (conflict) {
      await assert.rejects(action, /business_resource_owner_mismatch/);
      assert.equal(commands.length, 3, 'foreign ownership blocks every stop and publication');
      for (const name of f.names) assert.equal(await readFile(join(f.directory, name), 'utf8'), 'installed:' + name);
    } else {
      await action;
      assert.deepEqual(commands.slice(3), businessKinds.map(kind => ['stop', '--time', '20', kind + '-id']));
      assert.equal(JSON.parse(await readFile(join(f.directory, 'dashboard.json'), 'utf8')).uid, 'bairui-platform');
    }
  }
});
