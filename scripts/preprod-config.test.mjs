import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { stackConfig, gatewayConfig, bootstrapSql, assertOwned, assertLocalDocker, names } from './preprod-config.mjs';
import { missingDockerObject, dockerEndpoint } from './preprod-config.mjs';
import { up, paths } from './preprod.mjs';
import { monitorNames, monitorSecrets, monitorVolumes } from './monitoring-config.mjs';

const input = { installation: 'a'.repeat(24), nodeId: 'local-node', proxyIp: '10.0.1.3', revision: 'b'.repeat(16), schemaHash: 'c'.repeat(64) };

test('only actual missing Docker resources are treated as absent', () => {
  for (const text of ['Error: No such image: sample', 'Error response from daemon: network bairui-preprod-edge not found', 'Error response from daemon: secret bairui-preprod-env not found']) assert.equal(missingDockerObject(text), true);
  for (const text of ['permission denied', 'Cannot connect to Docker daemon', 'docker context not found']) assert.equal(missingDockerObject(text), false);
});

test('explicit Docker context takes precedence over DOCKER_HOST during locality checks', () => {
  const local = 'npipe:////./pipe/dockerDesktopLinuxEngine', remote = 'ssh://remote';
  assert.equal(dockerEndpoint({ DOCKER_CONTEXT: 'remote', DOCKER_HOST: local }, remote), remote);
  assert.equal(dockerEndpoint({ DOCKER_HOST: remote }, local), remote);
  assert.equal(dockerEndpoint({}, local), local);
});

test('only two production APIs and one pinned private database are deployed', () => {
  const stack = stackConfig(input);
  assert.deepEqual(Object.keys(stack.services).sort(), ['api', 'db']);
  const api = stack.services.api, db = stack.services.db;
  assert.equal(api.deploy.replicas, 2);
  assert.equal(api.user, '1000:1000');
  assert.equal(api.environment.NODE_ENV, 'production');
  assert.equal(api.environment.BAIRUI_PLATFORM_MODE, 'platform');
  assert.equal(api.environment.BAIRUI_AUTH_MODE, 'better-auth');
  assert.equal(api.environment.BETTER_AUTH_URL, 'https://localhost:8443');
  assert.equal(api.environment.BAIRUI_TRUSTED_PROXIES, '10.0.1.3/32');
  assert.equal(api.environment.BAIRUI_SIMULATION_ENABLED, '0');
  assert.equal(api.environment.DATABASE_URL, undefined);
  assert.equal(api.ports, undefined);
  assert.equal(db.ports, undefined);
  assert.deepEqual(db.deploy.placement.constraints, ['node.id == local-node']);
  assert.equal(api.deploy.update_config.failure_action, 'rollback');
  assert.equal(db.deploy.update_config.order, 'stop-first');
  assert.ok(api.healthcheck.test.join(' ').includes('/livez'));
  assert.equal(stack.volumes.pgdata.external.name, names.volume);
  assert.ok(!JSON.stringify(stack).includes('docker.sock'));
});

test('proxy addresses fail closed', () => {
  for (const proxyIp of ['0.0.0.0', '::', '10.0.0.0/8', '*', 'localhost', '10.0.0.1\nANYTHING']) assert.throws(() => stackConfig({ ...input, proxyIp }));
});

test('gateway serves HTTPS/static assets and separates API routing', () => {
  const config = gatewayConfig();
  assert.ok(config.includes('tls internal'));
  assert.ok(config.includes('tasks.' + names.api));
  assert.ok(config.indexOf('handle @api') < config.indexOf('try_files'));
  assert.ok(config.includes('/api/*'));
  assert.ok(!config.includes('keepalive off'));
  assert.ok(config.includes('response_header_timeout'));
  assert.ok(config.includes('Cache-Control "no-store"'));
  assert.ok(config.includes('handle_path /admin/*'));
  assert.ok(config.includes('root * /srv/admin'));
  assert.ok(config.indexOf('handle_path /admin/*') < config.indexOf('root * /srv\n'));
});

test('bootstrap uses file secrets and a restricted role in the independent database', () => {
  const sql = bootstrapSql([{ name: '001.sql', sql: 'SELECT 1;' }], input.schemaHash);
  assert.ok(sql.includes('NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'));
  assert.ok(sql.includes('/run/secrets/app-password'));
  assert.ok(sql.includes('bairui_preprod'));
  assert.ok(sql.includes(input.schemaHash));
  assert.ok(!sql.includes('ALTER ROLE bairui_app'));
  assert.ok(sql.includes('GRANT EXECUTE ON FUNCTION public.platform_admin_read(text,text,text,text,integer,text,text)'));
  const revoke = 'REVOKE ALL ON TABLE public.platform_role_bindings, public.platform_admin_audit FROM bairui_preprod_app;';
  assert.ok(sql.includes(revoke));
  assert.ok(sql.indexOf(revoke) > sql.indexOf('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES'));
});

test('ownership and local single-node checks fail closed', () => {
  assert.doesNotThrow(() => assertOwned({ 'bairui.preprod.installation': input.installation }, input.installation));
  assert.throws(() => assertOwned({}, input.installation));
  assert.throws(() => assertOwned({ 'bairui.preprod.installation': 'other' }, input.installation));
  const info = { OSType: 'linux', Swarm: { LocalNodeState: 'active', ControlAvailable: true, Nodes: 1 } };
  assert.doesNotThrow(() => assertLocalDocker(info, 'npipe:////./pipe/dockerDesktopLinuxEngine'));
  for (const host of ['tcp://remote:2376', 'ssh://someone', 'http://localhost']) assert.throws(() => assertLocalDocker(info, host));
  assert.throws(() => assertLocalDocker({ ...info, Swarm: { ...info.Swarm, Nodes: 2 } }, 'unix:///var/run/docker.sock'));
});

function recoveryFixture(t, { phase = 'running', volumes = [names.volume, names.caddyVolume], imagePrefix, imageLabels, missingImages = false, monitoring, absent = [] } = {}) {
  const installation = 'a'.repeat(24), labels = { 'bairui.preprod.installation': installation };
  const endpoint = 'npipe:////./pipe/dockerDesktopLinuxEngine';
  const state = { version: 1, installation, phase, secretsReady: true, nodeId: 'local-node', endpoint,
    schemaHash: createHash('sha256').update('[]').digest('hex'), ...(monitoring ? { monitoring } : {}) };
  const existingVolumes = new Set(volumes), commands = [], mutations = [], writes = [];
  const missing = (kind, name) => { throw new Error('No such ' + kind + ': ' + name); };
  function respond(args) {
    commands.push(args);
    const [kind, action, name] = args;
    if (kind === 'context') return endpoint;
    if (kind === 'info') return JSON.stringify({ OSType: 'linux', Swarm: {
      LocalNodeState: 'active', ControlAvailable: true, Nodes: 1, NodeID: state.nodeId,
    } });
    if (kind === 'ps') return '';
    if (action === 'inspect') {
      if (absent.includes(name)) return missing(kind, name);
      if (kind === 'volume' && !existingVolumes.has(name)) return missing(kind, name);
      if (kind === 'image') {
        if (missingImages) return missing(kind, name);
        return JSON.stringify({ Labels: labels, Config: { Labels: name.startsWith(imagePrefix ?? '!') ? imageLabels : labels } });
      }
      if (kind === 'container') return JSON.stringify({ Config: { Labels: labels, Image: 'previous-web-image' },
        State: { Running: phase !== 'stopped' }, NetworkSettings: { Networks: { [names.edge]: { IPAddress: '10.0.1.3' } } } });
      if (kind === 'network') return JSON.stringify({ Labels: labels, Driver: 'overlay', Attachable: true, Internal: name === names.data || name === monitorNames.network });
      return JSON.stringify({ Labels: labels, Spec: { Labels: labels } });
    }
    if (kind === 'stack' && action === 'config') return '';
    mutations.push(args);
    if (kind === 'stack' && action === 'deploy') throw new Error('unit_test_deployment_boundary');
    if (kind === 'volume' && action === 'create') existingVolumes.add(args.at(-1));
    return '';
  }
  t.mock.method(childProcess, 'execFile', (command, args, _options, callback) => {
    assert.equal(command, 'docker');
    queueMicrotask(() => {
      let stdout = '', error;
      try { stdout = respond(args); } catch (caught) { error = caught; }
      callback(error, stdout, error?.message ?? '');
    });
    return { stdin: { on() {}, end() {} } };
  });
  t.mock.method(fs, 'readFile', async path => {
    if (path === paths.state) return JSON.stringify(state);
    assert.ok(!String(path).includes('.env') && !String(path).includes('secrets'), 'unexpected_sensitive_file_read');
    return '';
  });
  t.mock.method(fs, 'readdir', async () => []);
  t.mock.method(fs, 'writeFile', async (path, data) => { writes.push({ path, data }); });
  t.mock.method(fs, 'rename', async () => {});
  t.mock.method(net, 'createServer', () => ({ once() {}, listen(_port, _host, done) { done(); }, close(done) { done(); } }));
  t.mock.method(console, 'log', () => {});
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { commands, mutations, writes };
}

for (const name of [...monitorVolumes, ...monitorSecrets, monitorNames.network]) {
  test('preprod up preserves installed monitoring and fails closed on missing ' + name, async t => {
    const fixture = recoveryFixture(t, { monitoring: { enabled: true, resourcesReady: true, phase: 'running' },
      volumes: [names.volume, names.caddyVolume, ...monitorVolumes], absent: [name] });
    await assert.rejects(up(), error => error.message.includes(name));
    assert.deepEqual(fixture.mutations, []);
    assert.deepEqual(fixture.writes, []);
  });
}

test('preprod up keeps monitoring attached and pauses API before gateway replacement', async t => {
  const fixture = recoveryFixture(t, { monitoring: { enabled: true, resourcesReady: true, phase: 'stopped' }, volumes: [names.volume, names.caddyVolume, ...monitorVolumes] });
  await assert.rejects(up(), /stack deploy/);
  const stack = JSON.parse(fixture.writes.find(w => w.path === paths.stack).data);
  assert.equal(stack.services.api.environment.BAIRUI_METRICS_ENABLED, '1');
  assert.equal(stack.services.api.environment.BAIRUI_TRUSTED_PROXIES, '10.0.1.3/32');
  const pause = fixture.mutations.findIndex(args => args[0] === 'service' && args[1] === 'scale' && args.includes(names.api + '=0'));
  const remove = fixture.mutations.findIndex(args => args[0] === 'container' && args[1] === 'rm');
  const connect = fixture.mutations.findIndex(args => args[0] === 'network' && args[1] === 'connect');
  assert.ok(pause >= 0 && pause < remove && remove < connect);
  const gateway = fixture.mutations.find(args => args[0] === 'run');
  assert.ok(gateway.includes('127.0.0.1:9443:9443'));
  assert.ok(!fixture.mutations.some(args => ['volume', 'secret'].includes(args[0])));
});

for (const phase of ['running', 'stopped']) {
  for (const volume of [names.volume, names.caddyVolume]) {
    test(phase + ' installation rejects missing ' + volume + ' before any mutation', async t => {
      const fixture = recoveryFixture(t, { phase, volumes: [names.volume, names.caddyVolume].filter(name => name !== volume), missingImages: true });
      await assert.rejects(up(), error => error.message.includes(volume));
      assert.deepEqual(fixture.mutations, []);
      assert.deepEqual(fixture.writes, []);
    });
  }
}

for (const imagePrefix of ['bairui/platform-api-preprod:', 'bairui/platform-web-preprod:']) {
  for (const imageLabels of [undefined, { 'bairui.preprod.installation': 'f'.repeat(24) }]) {
    test(imagePrefix + ' rejects ' + (imageLabels ? 'foreign' : 'missing') + ' Config.Labels', async t => {
      const fixture = recoveryFixture(t, { imagePrefix, imageLabels });
      await assert.rejects(up(), /resource_not_owned_by_this_installation/);
      assert.deepEqual(fixture.mutations, []);
    });
  }
}

test('owned image Config.Labels allow reuse without rebuilding', async t => {
  const fixture = recoveryFixture(t);
  await assert.rejects(up(), /stack deploy/);
  assert.equal(fixture.commands.filter(args => args[0] === 'image' && args[1] === 'inspect').length, 2);
  assert.ok(!fixture.mutations.some(args => args[0] === 'build'));
  assert.ok(!fixture.mutations.some(args => args[0] === 'volume'));
});

test('absent images are built with the current installation label', async t => {
  const fixture = recoveryFixture(t, { missingImages: true });
  await assert.rejects(up(), /stack deploy/);
  const builds = fixture.mutations.filter(args => args[0] === 'build');
  assert.equal(builds.length, 2);
  for (const args of builds) assert.equal(args[args.indexOf('--label') + 1], 'bairui.preprod.installation=' + 'a'.repeat(24));
});

for (const volumes of [[], [names.volume], [names.caddyVolume], [names.volume, names.caddyVolume]]) {
  test('initializing installation resumes idempotently with ' + volumes.length + ' existing volumes: ' + volumes.join(', '), async t => {
    const fixture = recoveryFixture(t, { phase: 'initializing', volumes });
    await assert.rejects(up(), /stack deploy/);
    const expected = [names.volume, names.caddyVolume].filter(name => !volumes.includes(name));
    assert.deepEqual(fixture.mutations.filter(args => args[0] === 'volume').map(args => args.at(-1)), expected);
    fixture.mutations.length = 0;
    await assert.rejects(up(), /stack deploy/);
    assert.ok(!fixture.mutations.some(args => args[0] === 'volume' || args[0] === 'secret'));
  });
}
