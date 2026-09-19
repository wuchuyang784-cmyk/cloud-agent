import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { assertMonitoringResources, ensureMonitoringResources } from './monitoring.mjs';
import { docker } from './preprod.mjs';
import { monitorNames, monitorSecrets, monitorVolumes } from './monitoring-config.mjs';

function fixture(t, { absent = [], foreign, installed = true, internal = true, failInitializer = false } = {}) {
  const state = { installation: 'a'.repeat(24), nodeId: 'local-node', revision: 'b'.repeat(16),
    monitoring: installed ? { enabled: true, phase: 'running', resourcesReady: true, secretsReady: true } : undefined };
  const missing = new Set(absent), mutations = [], writes = [];
  t.mock.method(childProcess, 'execFile', (_command, args, _options, callback) => {
    queueMicrotask(() => {
      const [kind, action, name] = args;
      if (action === 'inspect') {
        if (missing.has(name)) return callback(new Error('missing'), '', 'No such ' + kind + ': ' + name);
        const labels = { 'bairui.preprod.installation': name === foreign ? 'f'.repeat(24) : state.installation };
        return callback(null, JSON.stringify({ Labels: labels, Spec: { Labels: labels }, Config: { Labels: labels }, Driver: 'overlay', Attachable: true, Internal: internal }), '');
      }
      mutations.push(args);
      if (kind === 'run' && failInitializer) {
        failInitializer = false;
        return callback(new Error('interrupted'), '', 'initializer interrupted');
      }
      if (action === 'create') missing.delete(args.at(-1) === '-' ? args.at(-2) : args.at(-1));
      callback(null, '', '');
    });
    return { stdin: { on() {}, end() {} } };
  });
  t.mock.method(fs, 'writeFile', async (_path, data) => { writes.push(String(data)); });
  t.mock.method(fs, 'rename', async () => {});
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { state, mutations, writes };
}

test('explicit log capture includes stderr without changing JSON command output', async t => {
  t.mock.method(childProcess, 'execFile', (_command, _args, _options, callback) => {
    queueMicrotask(() => callback(null, '{"ok":true}\n', 'error-stream-marker\n'));
    return { stdin: { on() {}, end() {} } };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(await docker(['inspect']), '{"ok":true}');
  assert.match(await docker(['logs'], { includeStderr: true }), /error-stream-marker/);
});

test('interrupted volume initialization retries ownership setup before marking resources ready', async t => {
  const { state, mutations } = fixture(t, { installed: false, failInitializer: true,
    absent: [...monitorVolumes, ...monitorSecrets, monitorNames.network] });
  await assert.rejects(ensureMonitoringResources(state), /Docker/);
  assert.equal(state.monitoring.resourcesReady, false);
  mutations.length = 0;
  await ensureMonitoringResources(state);
  assert.equal(state.monitoring.resourcesReady, true);
  const initialized = mutations.filter(args => args[0] === 'run').map(args => args[args.indexOf('--mount') + 1]);
  for (const name of monitorVolumes) assert.ok(initialized.includes('type=volume,source=' + name + ',target=/data'), name);
  assert.ok(!mutations.some(args => args[0] === 'secret' && args[1] === 'create'));
});

for (const name of [...monitorVolumes, ...monitorSecrets, monitorNames.network]) {
  test('installed monitoring rejects missing ' + name + ' without mutations', async t => {
    const { state, mutations } = fixture(t, { absent: [name] });
    await assert.rejects(ensureMonitoringResources(state), error => error.message.includes(name));
    assert.deepEqual(mutations, []);
  });
}

test('foreign monitoring service is rejected before resource changes', async t => {
  const { state, mutations } = fixture(t, { foreign: monitorNames.grafana });
  await assert.rejects(ensureMonitoringResources(state), /resource_not_owned/);
  assert.deepEqual(mutations, []);
});

test('monitoring overlay must be internal', async t => {
  const { state, mutations } = fixture(t, { internal: false });
  await assert.rejects(assertMonitoringResources(state), /network/);
  assert.deepEqual(mutations, []);
});

test('partly missing secrets never cause replacement password creation', async t => {
  const { state, mutations } = fixture(t, { installed: false, absent: [monitorNames.grafanaSecret] });
  await assert.rejects(ensureMonitoringResources(state), /Secret/);
  assert.deepEqual(mutations, []);
});

test('new monitoring installation creates only owned resources and no secret files', async t => {
  const { state, mutations, writes } = fixture(t, { installed: false, absent: [...monitorVolumes, ...monitorSecrets, monitorNames.network] });
  await ensureMonitoringResources(state);
  assert.equal(state.monitoring.resourcesReady, true);
  assert.equal(state.monitoring.secretsReady, true);
  assert.equal(mutations.filter(args => args[0] === 'secret' && args[1] === 'create').length, 3);
  assert.equal(mutations.filter(args => args[0] === 'volume' && args[1] === 'create').length, 4);
  for (const args of mutations.filter(args => args[1] === 'create')) assert.ok(args.includes('bairui.preprod.installation=' + state.installation));
  assert.ok(!writes.join('').includes('DATABASE_URL'));
  for (const data of writes) assert.ok(!/[a-f0-9]{64}/.test(data), 'no_secret_material_in_state');
  mutations.length = 0;
  await ensureMonitoringResources(state);
  assert.deepEqual(mutations, []);
});
