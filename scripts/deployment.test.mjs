import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseDeploymentArguments, runDeployment } from './deployment.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const state = { phase: 'running', installation: 'a'.repeat(24), revision: 'b'.repeat(16) };
  const deps = {
    context: async () => { calls.push('context'); return { state }; },
    compatible: async () => calls.push('compatible'),
    up: async options => calls.push(['up', options]),
    stop: async () => { calls.push('stop'); state.phase = 'stopped'; },
    backup: async () => { calls.push('backup'); return '/private/backup'; },
    status: async () => calls.push('status'),
    logs: async options => calls.push(['logs', options]),
    consolidate: async () => calls.push('consolidate'),
    report: () => {}, ...overrides,
  };
  return { calls, state, deps };
}

test('strict command parsing rejects unsupported targets and unbounded logs before Docker is consulted', () => {
  assert.deepEqual(parseDeploymentArguments(['up']), { command: 'up' });
  assert.deepEqual(parseDeploymentArguments(['up', '--replicas', '2']), { command: 'up', replicas: 2 });
  assert.deepEqual(parseDeploymentArguments(['logs', 'api', '--tail', '50']), { command: 'logs', component: 'api', tail: 50 });
  for (const args of [['up', '--replicas', '0'], ['up', '--replicas', '3'], ['logs', '--tail', '100000'],
    ['logs', '../../secrets'], ['update', '--force'], ['stop', '--replicas', '2'], ['up', 'business'],
    ['consolidate'], ['consolidate', 'business'], ['up', '--replicas', '1', '--replicas', '2']]) {
    assert.throws(() => parseDeploymentArguments(args), /deployment_arguments_invalid/);
  }
});

test('up defaults to one replica and preserves an explicitly saved two-replica target', async () => {
  const f = fixture();
  await runDeployment({ command: 'up' }, f.deps);
  assert.deepEqual(f.calls.at(-1), ['up', { apiReplicas: 1 }]);
  f.state.apiReplicas = 2;
  await runDeployment({ command: 'up' }, f.deps);
  assert.deepEqual(f.calls.at(-1), ['up', { apiReplicas: 2 }]);
  await runDeployment({ command: 'up', replicas: 1 }, f.deps);
  assert.deepEqual(f.calls.at(-1), ['up', { apiReplicas: 1 }]);
});

test('update validates compatibility before stopping and backs up before changing the installation', async () => {
  const f = fixture();
  await runDeployment({ command: 'update' }, f.deps);
  assert.deepEqual(f.calls, ['context', 'compatible', 'stop', 'context', 'backup', ['up', { apiReplicas: 1 }]]);
});

test('update never restarts or rebuilds when the cold backup fails', async () => {
  const f = fixture({ backup: async () => { throw new Error('archive_failed'); } });
  await assert.rejects(runDeployment({ command: 'update' }, f.deps), /archive_failed/);
  assert.equal(f.state.phase, 'stopped');
  assert.ok(!f.calls.some(c => Array.isArray(c) && c[0] === 'up'));
});

test('schema mismatch and ownership failure cannot stop, back up or start any service', async () => {
  for (const overrides of [{ compatible: async () => { throw new Error('schema_changed'); } },
    { context: async () => { throw new Error('owner_mismatch'); } }]) {
    const f = fixture(overrides);
    await assert.rejects(runDeployment({ command: 'update' }, f.deps));
    assert.ok(!f.calls.includes('stop') && !f.calls.includes('backup'));
  }
});

test('unfinished backup helpers prevent starting or updating the installation', async () => {
  const f = fixture();
  f.deps.context = async () => ({ state: f.state, backupHelpers: ['a'.repeat(64)] });
  for (const command of ['up', 'update', 'check']) {
    await assert.rejects(runDeployment({ command }, f.deps), /deployment_backup_helper_pending/);
  }
  assert.deepEqual(f.calls, []);
});

test('duplicate monitoring is stopped only by the explicit consolidate target', async () => {
  const f = fixture();
  await runDeployment(parseDeploymentArguments(['consolidate', 'business-monitoring']), f.deps);
  assert.deepEqual(f.calls, ['context', 'consolidate']);
});

test('check and status never start services; missing installs cannot be updated or backed up', async () => {
  const f = fixture();
  await runDeployment({ command: 'check' }, f.deps);
  await runDeployment({ command: 'status' }, f.deps);
  assert.deepEqual(f.calls, ['context', 'compatible', 'context', 'status']);
  f.deps.context = async () => ({ state: null });
  await assert.rejects(runDeployment({ command: 'update' }, f.deps), /deployment_not_installed/);
  await assert.rejects(runDeployment({ command: 'backup' }, f.deps), /deployment_not_installed/);
});

test('real CLI help needs no Docker and invalid command cannot reach a remote Docker endpoint', async () => {
  const exec = promisify(execFile), file = fileURLToPath(new URL('./deployment.mjs', import.meta.url));
  const env = { ...process.env, DOCKER_HOST: 'ssh://unreachable.invalid', BAIRUI_CONSOLE_PUBLIC_ORIGIN: 'invalid' };
  const help = await exec(process.execPath, [file, '--help'], { env, timeout: 5000, windowsHide: true });
  assert.match(help.stdout, /consolidate business-monitoring/);
  await assert.rejects(exec(process.execPath, [file, 'logs', '../../secrets'], { env, timeout: 5000, windowsHide: true }), error => {
    assert.equal(error.code, 1); assert.match(error.stderr, /用法/); assert.doesNotMatch(error.stderr, /Docker 命令失败/); return true;
  });
});
