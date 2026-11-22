import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coldDeploymentBackup, backupVolumeArguments, assertStoppedInstallation, preflightDeploymentBackup, runBackupHelper } from './deployment-backup.mjs';
import { names, label, apiImage } from './preprod-config.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bairui-deploy-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'output', 'preprod'), { recursive: true });
  const state = { installation: 'a'.repeat(24), revision: 'b'.repeat(16), phase: 'stopped', version: 1 };
  await writeFile(join(directory, 'output', 'preprod', 'state.json'), JSON.stringify(state));
  const context = { state, services: { api: { Spec: { Mode: { Replicated: { Replicas: 0 } } } } }, standalone: {}, volumes: [names.volume, names.caddyVolume] };
  const commands = [];
  const deps = { sourceRoot: directory, backupRoot: join(directory, 'output', 'deployment', 'backups'),
    inspect: async () => null,
    protect: async () => {},
    find: async (kind, name) => ({ Name: name, ID: 'secret-id', Labels: { [label]: state.installation } }),
    command: async args => {
      commands.push(args);
      if (args[0] === 'ps') return '';
      if (args[0] === 'run' && args.includes('tar')) {
        const destination = args.find(a => a.includes('target=/backup')).split('source=')[1].split(',target=')[0];
        await writeFile(join(destination, args[args.indexOf('-czf') + 1].split('/').at(-1)), 'fixture archive bytes');
      }
      return '';
    },
  };
  return { directory, context, commands, deps };
}

test('backup refuses a desired running service or running standalone component before writing archives', () => {
  const state = { phase: 'stopped' };
  assert.throws(() => assertStoppedInstallation({ state, services: { api: { Spec: { Mode: { Replicated: { Replicas: 1 } } } } }, standalone: {} }), /deployment_backup_requires_stopped/);
  assert.throws(() => assertStoppedInstallation({ state, services: {}, standalone: { gateway: { State: { Running: true } } } }), /deployment_backup_requires_stopped/);
  assert.throws(() => assertStoppedInstallation({ state: { phase: 'running' }, services: {}, standalone: {} }), /deployment_backup_requires_stopped/);
});

test('archive helper has no network, read-only data mount and no Docker socket or new image pull', () => {
  const args = backupVolumeArguments({ volume: names.volume, directory: '/safe/backup', state: { installation: 'a'.repeat(24), revision: 'b'.repeat(16) } });
  assert.ok(args.includes('--rm') && args.includes('--pull=never') && args.includes('--network=none'));
  assert.ok(args.includes('--read-only') && args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('type=volume,source=' + names.volume + ',target=/source,readonly'));
  assert.ok(args.includes(apiImage('b'.repeat(16))));
  assert.ok(!args.join(' ').includes('docker.sock'));
  assert.throws(() => backupVolumeArguments({ volume: '../other', directory: '/safe/backup', state: {} }));
});

test('any actual running volume consumer blocks backup even if state says stopped', async t => {
  const f = await fixture(t);
  f.deps.command = async args => { f.commands.push(args); return args[0] === 'ps' ? 'external-writer-id' : ''; };
  await assert.rejects(coldDeploymentBackup(f.context, f.deps), /deployment_backup_volume_in_use/);
  assert.ok(!f.commands.some(a => a[0] === 'run'));
});

test('missing persistent volume or missing image cannot be recreated by backup', async t => {
  const f = await fixture(t);
  f.deps.find = async () => null;
  await assert.rejects(coldDeploymentBackup(f.context, f.deps), /deployment_backup_resource_missing/);
  assert.equal(f.commands.length, 0);
});

test('completed backup checksums each archive and copies private configuration without reading business env', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, '.env'), 'DO_NOT_READ=this-is-business');
  const path = await coldDeploymentBackup(f.context, f.deps);
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.installation, f.context.state.installation);
  assert.equal(manifest.secretValuesIncluded, false);
  assert.deepEqual(manifest.volumes.map(v => v.name), f.context.volumes);
  assert.ok(manifest.volumes.every(v => /^[a-f0-9]{64}$/.test(v.sha256) && v.bytes > 0));
  assert.ok(!JSON.stringify(manifest).includes('DO_NOT_READ'));
  assert.deepEqual(JSON.parse(await readFile(join(path, 'files', 'preprod', 'state.json'), 'utf8')), f.context.state);
  assert.equal(f.commands.filter(a => a[0] === 'run').length, 4, 'each archive is created and validated');
});

test('archive failure never publishes a complete backup or starts original services', async t => {
  const f = await fixture(t);
  const command = f.deps.command;
  f.deps.command = async args => { if (args[0] === 'run') throw new Error('archive_failed'); return command(args); };
  await assert.rejects(coldDeploymentBackup(f.context, f.deps), /archive_failed/);
  const [entry] = await readdir(f.deps.backupRoot);
  const manifest = JSON.parse(await readFile(join(f.deps.backupRoot, entry, 'manifest.json'), 'utf8'));
  assert.equal(manifest.complete, false);
  assert.ok(!f.commands.some(a => ['start', 'service', 'stack'].includes(a[0])));
});

test('running-install preflight detects missing old image or unreadable configuration before stop is allowed', async t => {
  const f = await fixture(t); f.context.state.phase = 'running';
  f.deps.find = async () => null;
  await assert.rejects(preflightDeploymentBackup(f.context, f.deps, { stopped: false }), /deployment_backup_resource_missing/);
  f.deps.find = async (_kind, name) => ({ ID: name });
  await rm(join(f.directory, 'output', 'preprod', 'state.json'));
  await assert.rejects(preflightDeploymentBackup(f.context, f.deps, { stopped: false }), /deployment_backup_config_missing/);
  assert.equal(f.commands.length, 0);
});

test('failed Docker client cleans up only its verified random backup helper full ID', async () => {
  let actual, removed;
  const state = { installation: 'a'.repeat(24), revision: 'b'.repeat(16) };
  const deps = {
    command: async args => {
      if (args[0] === 'run') { actual = args; throw new Error('docker_client_timed_out'); }
      removed = args;
    },
    inspect: async (_kind, name) => {
      const labels = {};
      actual.forEach((arg, i) => { if (arg === '--label') { const [key, value] = actual[i + 1].split('='); labels[key] = value; } });
      return { Name: '/' + name, Id: 'c'.repeat(64), Config: { Labels: labels } };
    },
  };
  await assert.rejects(runBackupHelper(backupVolumeArguments({ volume: names.volume, directory: '/backup', state }), ['tar'], state, deps), /docker_client_timed_out/);
  assert.deepEqual(removed, ['rm', '--force', 'c'.repeat(64)]);
  removed = undefined;
  deps.inspect = async () => ({ Name: '/foreign', Id: 'd'.repeat(64), Config: { Labels: {} } });
  await assert.rejects(runBackupHelper(backupVolumeArguments({ volume: names.volume, directory: '/backup', state }), ['tar'], state, deps), /deployment_backup_helper_mismatch/);
  assert.equal(removed, undefined);
});
