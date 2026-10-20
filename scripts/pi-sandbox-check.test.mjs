import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm, symlink, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const cliPath = fileURLToPath(new URL('./pi-sandbox-check.mjs', import.meta.url));
const FAILURE = 'Sandbox policy check failed\n';
const MiB = 1024 ** 2;
function fixture() {
  return {
    schemaVersion: 1, installationId: 'install-private-01',
    identity: { organizationId: 'org-private', ownerUserId: 'owner-private', agentId: 'agent-private',
      runId: 'run-11111111-1111-4111-8111-111111111111', runGeneration: 1,
      sessionId: '22222222-2222-4222-8222-222222222222' },
    sandboxImage: `sha256:${'a'.repeat(64)}`, controlImage: `sha256:${'b'.repeat(64)}`,
    runtime: 'runsc', storageRoot: '/srv/private-storage',
    gatewayUrl: 'https://private-gateway.invalid/v1', model: 'private-model',
    resources: { cpuMillis: 500, memoryBytes: 256 * MiB, pidsLimit: 64,
      tmpfsBytes: 16 * MiB, workspaceBytes: 1024 * MiB, workspaceInodes: 4096 },
  };
}
async function config(t, content = JSON.stringify(fixture())) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-policy-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'private-config.json');
  await writeFile(filename, content, { mode: 0o600 });
  return { directory, filename };
}
function cli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, ...options,
  });
}
function rejected(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, FAILURE);
}
async function api() {
  try { return await import('./pi-sandbox-check.mjs'); }
  catch (error) { assert.fail(`Sandbox check implementation missing: ${error.code}`); }
}

test('explicit private profile produces only a redacted policy-only summary', async t => {
  const { filename } = await config(t);
  const result = cli(['--config', filename]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.mode, 'policy-only');
  assert.equal(summary.deploymentReady, false);
  assert.equal(summary.nativeChecksPerformed, false);
  assert.deepEqual(Object.keys(summary).sort(), [
    'deploymentReady', 'mode', 'names', 'nativeChecksPerformed', 'requiredNativeChecks',
  ]);
  assert.deepEqual(summary.requiredNativeChecks, [
    'runsc', 'images', 'quotas', 'ownership', 'egress', 'process-cleanup', 'capacity',
  ]);
  assert.match(summary.names.sandbox, /^pi-sandbox-[a-f0-9]{64}$/);
  assert.match(summary.names.control, /^pi-control-[a-f0-9]{64}$/);
  for (const value of [filename, fixture().installationId, ...Object.values(fixture().identity).filter(v => typeof v === 'string'),
    fixture().gatewayUrl, fixture().storageRoot, fixture().model]) {
    assert.equal(result.stdout.includes(value), false, `Summary leaked ${value}`);
  }
  assert.equal(result.stdout.includes('Secret'), false);
});

test('exports bounded read/check APIs and accepts normalized relative paths', async t => {
  const { directory, filename } = await config(t);
  const { readSandboxProfileFile, checkSandboxPolicyFile } = await api();
  assert.deepEqual(await readSandboxProfileFile(filename), fixture());
  const summary = await checkSandboxPolicyFile(filename);
  assert.equal(summary.mode, 'policy-only');
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.names), true);
  assert.equal(Object.isFrozen(summary.requiredNativeChecks), true);
  const relative = path.relative(process.cwd(), path.join(directory, 'unused', '..', 'private-config.json'));
  assert.deepEqual(await checkSandboxPolicyFile(relative), summary);
  assert.equal(cli(['--config', relative]).status, 0);
});

test('read/check APIs use fixed diagnostics without exposing private input or paths', async t => {
  const { directory } = await config(t);
  const { readSandboxProfileFile, checkSandboxPolicyFile } = await api();
  for (const operation of [readSandboxProfileFile, checkSandboxPolicyFile]) {
    for (const value of [undefined, null, {}, '', 'PRIVATE-CANARY\0', path.join(directory, 'PRIVATE-CANARY')]) {
      await assert.rejects(operation(value), error => error.message === FAILURE.trim()
        && !JSON.stringify(error).includes('PRIVATE-CANARY') && !JSON.stringify(error).includes(directory));
    }
    const { filename } = await config(t, '{"secret":"PRIVATE-CANARY"}');
    await assert.rejects(operation(filename), error => error.message === FAILURE.trim());
  }
});

test('only permits one explicit --config flag and never accepts deployment commands', async t => {
  const { filename } = await config(t);
  for (const args of [[], ['--config'], ['--config', ''], [filename], ['--up'], ['--help'],
    ['--config', filename, '--up'], ['--config', filename, 'extra'],
    ['--config', filename, '--config', filename], [`--config=${filename}`]]) rejected(cli(args));
});

test('does not fall back to configuration environment variables or business .env', async t => {
  const { directory, filename } = await config(t);
  await writeFile(path.join(directory, '.env'), 'BAIRUI_PI_SANDBOX_CONFIG=PRIVATE-CANARY\n');
  rejected(cli([], { cwd: directory, env: { ...process.env,
    BAIRUI_PI_SANDBOX_CONFIG: filename, BAIRUI_SANDBOX_CONFIG: filename, CONFIG: filename } }));
  assert.equal(cli(['--config', filename], { cwd: directory,
    env: { ...process.env, BAIRUI_PI_SANDBOX_CONFIG: 'PRIVATE-CANARY' } }).status, 0);
});

test('all invalid schemas and filesystem errors have the same private diagnostic', async t => {
  for (const value of [{ ...fixture(), secret: 'PRIVATE-CANARY' }, { ...fixture(), runtime: 'runc' },
    { ...fixture(), resources: {} }, {}, null]) {
    const { filename } = await config(t, JSON.stringify(value));
    rejected(cli(['--config', filename]));
  }
  const { directory } = await config(t);
  rejected(cli(['--config', directory]));
  rejected(cli(['--config', path.join(directory, 'PRIVATE-CANARY-missing')]));
});

test('rejects files exceeding 16 KiB and malformed UTF-8 or JSON', async t => {
  for (const content of [Buffer.alloc(16 * 1024 + 1, 0x20),
    Buffer.concat([Buffer.from(JSON.stringify(fixture())), Buffer.from([0xc3, 0x28])]),
    Buffer.from('{"model":"PRIVATE-CANARY"'), Buffer.alloc(0)]) {
    const { filename } = await config(t, content);
    rejected(cli(['--config', filename]));
  }
});

test('accepts a valid file at exactly the byte limit', async t => {
  const serialized = JSON.stringify(fixture());
  const { filename } = await config(t, serialized.padEnd(16 * 1024, ' '));
  assert.equal(cli(['--config', filename]).status, 0);
});

test('rejects symbolic-link config files', async t => {
  const { directory, filename } = await config(t);
  const link = path.join(directory, 'config-link.json');
  try { await symlink(filename, link, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Windows file symlinks unavailable: ${error.code}`); return;
    }
    throw error;
  }
  rejected(cli(['--config', link]));
});

test('rejects a symbolic-link or junction parent directory', async t => {
  const { directory } = await config(t);
  const real = path.join(directory, 'real');
  await mkdir(real);
  await writeFile(path.join(real, 'config.json'), JSON.stringify(fixture()), { mode: 0o600 });
  const linked = path.join(directory, 'linked');
  await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
  rejected(cli(['--config', path.join(linked, 'config.json')]));
});

test('enforces private file permissions on POSIX', { skip: process.platform === 'win32' }, async t => {
  const { filename } = await config(t);
  for (const mode of [0o644, 0o660, 0o666, 0o700]) {
    await chmod(filename, mode);
    rejected(cli(['--config', filename]));
  }
  await chmod(filename, 0o600);
  assert.equal(cli(['--config', filename]).status, 0);
});

test('module import is inert even when argv contains a misleading script suffix and --up', () => {
  const program = `process.argv = [process.execPath, ${JSON.stringify(`${cliPath}.other`)}, '--up'];
    process.env.BAIRUI_PI_SANDBOX_CONFIG = 'PRIVATE-CANARY';
    await import(${JSON.stringify(pathToFileURL(cliPath).href)});
    console.log('import-only');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'import-only\n');
  assert.equal(result.stderr, '');
});

test('production checker contains no execution, network, database, or environment-loading entrypoints', async () => {
  const source = await readFile(cliPath, 'utf8');
  for (const forbidden of ['child_process', 'dotenv', 'process.env', 'createServer', 'node:net', 'node:http',
    'node:https', 'node:tls', 'docker', 'pg', '.readFile(']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
