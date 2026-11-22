import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { mkdir, readFile, writeFile, rename, lstat, readdir, chmod, access } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { docker, owned, inspect, root } from './preprod.mjs';
import { names, label, apiImage } from './preprod-config.mjs';
import { monitorSecrets } from './monitoring-config.mjs';
import { runtimeNames } from './runtime-deployment-config.mjs';
import { resourceDefinitions } from './deployment-resources.mjs';

const exec = promisify(execFile);

export function assertStoppedInstallation(context) {
  const stopped = context.state?.phase === 'stopped'
    && Object.values(context.services).every(item => !item || item.Spec?.Mode?.Replicated?.Replicas === 0)
    && Object.values(context.standalone).every(item => !item?.State?.Running);
  assert.ok(stopped, 'deployment_backup_requires_stopped: 先执行 npm run deploy -- stop；不会自动启动数据库或停止未知写入者。');
}

export function backupVolumeArguments({ volume, directory, state }) {
  assert.match(state.installation, /^[a-f0-9]{24}$/, 'deployment_backup_installation_invalid');
  assert.match(state.revision, /^[a-f0-9]{16}$/, 'deployment_backup_revision_invalid');
  assert.ok(resourceDefinitions(state).volumes.includes(volume), 'deployment_backup_volume_invalid');
  const source = resolve(directory).replaceAll('\\', '/');
  assert.ok(!/[\r\n,\0]/.test(source), 'deployment_backup_path_invalid');
  return ['run', '--rm', '--pull=never', '--network=none', '--read-only', '--user=0:0',
    '--cap-drop=ALL', '--cap-add=DAC_OVERRIDE', '--cap-add=CHOWN', '--security-opt=no-new-privileges:true',
    '--pids-limit=32', '--memory=128m', '--cpus=0.25', '--label', label + '=' + state.installation,
    '--mount', 'type=volume,source=' + volume + ',target=/source,readonly',
    '--mount', 'type=bind,source=' + source + ',target=/backup', apiImage(state.revision)];
}

async function protect(directory) {
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return; }
  const account = (await exec('whoami', [], { windowsHide: true })).stdout.trim();
  await exec('icacls', [directory, '/inheritance:r', '/grant:r', account + ':(OI)(CI)F', 'SYSTEM:(OI)(CI)F'], { windowsHide: true });
}

async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, 'deployment_backup_archive_invalid');
  return { sha256: hash.digest('hex'), bytes: stat.size };
}

// Explicit paths only; never copy .env, an output directory wholesale, or the host-root symlink.
async function snapshotFiles(context, sourceRoot, destination) {
  const files = [];
  const copy = async (name, required = false, depth = 0) => {
    assert.ok(depth < 8 && files.length < 256, 'deployment_backup_file_limit');
    const source = join(sourceRoot, 'output', name), target = destination && join(destination, 'files', name);
    const parent = relative(join(sourceRoot, 'output'), source);
    assert.ok(parent && !parent.startsWith('..' + sep) && !parent.startsWith(sep), 'deployment_backup_source_invalid');
    let ancestor = join(sourceRoot, 'output');
    for (const part of name.split(/[\\/]/).slice(0, -1)) {
      const info = await lstat(ancestor);
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'deployment_backup_symlink_forbidden');
      ancestor = join(ancestor, part);
    }
    // Check the final parent too: lstat(file) alone would follow a linked directory.
    const parentInfo = await lstat(ancestor);
    assert.ok(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), 'deployment_backup_symlink_forbidden');
    let stat;
    try { stat = await lstat(source); }
    catch (error) { if (!required && error.code === 'ENOENT') return; throw new Error('deployment_backup_config_missing'); }
    assert.ok(!stat.isSymbolicLink(), 'deployment_backup_symlink_forbidden');
    if (stat.isDirectory()) {
      if (target) await mkdir(target, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(source)) await copy(join(name, entry), true, depth + 1);
      return;
    }
    assert.ok(stat.isFile() && stat.size <= 1024 * 1024, 'deployment_backup_config_invalid');
    const content = await readFile(source);
    if (target) {
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600, flag: 'wx' });
    }
    files.push({ path: 'files/' + name.replaceAll('\\', '/'), sha256: createHash('sha256').update(content).digest('hex') });
  };
  for (const name of ['state.json', 'Caddyfile', 'stack.json', 'monitoring-stack.json', 'root.crt']) {
    await copy('preprod/' + name, name === 'state.json');
  }
  if (context.runtime) await copy('runtime/preprod', true);
  return files;
}

async function checkBackupDestination(deps) {
  const suffix = relative(resolve(deps.sourceRoot, 'output'), resolve(deps.backupRoot));
  assert.ok(suffix && !suffix.startsWith('..') && !suffix.startsWith(sep), 'deployment_backup_path_invalid');
  let path = join(deps.sourceRoot, 'output');
  for (const part of suffix.split(sep)) {
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'deployment_backup_symlink_forbidden');
    await access(path, constants.W_OK);
    path = join(path, part);
  }
  try {
    const info = await lstat(path);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'deployment_backup_symlink_forbidden');
    await access(path, constants.W_OK);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const dependencies = overrides => ({ sourceRoot: root, backupRoot: join(root, 'output', 'deployment', 'backups'), command: docker,
  find: owned, inspect, protect, ...overrides });

export async function preflightDeploymentBackup(context, overrides = {}, { stopped = true } = {}) {
  const deps = dependencies(overrides);
  if (stopped) assertStoppedInstallation(context);
  const { state } = context;
  assert.match(state.installation, /^[a-f0-9]{24}$/, 'deployment_backup_installation_invalid');
  assert.match(state.revision, /^[a-f0-9]{16}$/, 'deployment_backup_revision_invalid');
  const expectedVolumes = resourceDefinitions(state).volumes;
  assert.deepEqual(context.volumes, expectedVolumes, 'deployment_backup_volume_inventory_invalid');
  // Finish all resource and active writer checks before creating the backup directory.
  assert.ok(await deps.find('image', apiImage(state.revision), state), 'deployment_backup_resource_missing:image');
  for (const name of expectedVolumes) {
    assert.ok(await deps.find('volume', name, state), 'deployment_backup_resource_missing:' + name);
    if (stopped) assert.equal(await deps.command(['ps', '-q', '--filter', 'volume=' + name]), '', 'deployment_backup_volume_in_use:' + name);
  }
  const secretNames = [names.envSecret, names.adminSecret, names.appSecret,
    ...(state.monitoring?.resourcesReady ? monitorSecrets : []), ...(context.runtime ? [runtimeNames('preprod').metricsSecret] : [])];
  const secrets = [];
  for (const name of secretNames) {
    const item = await deps.find('secret', name, state);
    assert.ok(item, 'deployment_backup_resource_missing:' + name);
    secrets.push({ name, id: item.ID });
  }
  await snapshotFiles(context, deps.sourceRoot);
  await checkBackupDestination(deps);
  return secrets;
}

export function backupArchiveCommands(file) {
  assert.match(file, /^[a-z0-9-]+\.tar\.gz$/, 'deployment_backup_archive_name_invalid');
  const archive = "const fs=require('node:fs'),cp=require('node:child_process'),a=process.argv.slice(1);process.umask(0o077);cp.execFileSync(a[0],a.slice(1,-2),{stdio:'ignore',timeout:1500000});fs.chmodSync(a[2],0o600);fs.chownSync(a[2],Number(a.at(-2)),Number(a.at(-1)));";
  const verify = "require('node:child_process').execFileSync('tar',['-tzf',process.argv[1]],{stdio:'ignore',timeout:1500000});";
  return { archive: ['node', '-e', archive, '--', 'tar', '-czf', '/backup/' + file, '-C', '/source', '.',
    String(process.getuid?.() ?? 0), String(process.getgid?.() ?? 0)],
  verify: ['node', '-e', verify, '--', '/backup/' + file] };
}

// A timed-out Docker client does not imply its container stopped. Always inspect
// and remove only this random operation's full ID; never remove a name conflict.
export async function runBackupHelper(args, commandArgs, state, deps) {
  const operation = randomBytes(12).toString('hex'), name = 'bairui-backup-' + operation;
  const labels = { [label]: state.installation, 'bairui.deployment.backup': state.installation, 'bairui.deployment.backup.operation': operation };
  const command = [...args.slice(0, -1), '--name', name,
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', key + '=' + value]), args.at(-1), ...commandArgs];
  try { return await deps.command(command, { timeout: 1800000 }); }
  finally {
    const item = await deps.inspect('container', name);
    if (item) {
      assert.equal(item.Name, '/' + name, 'deployment_backup_helper_mismatch');
      for (const [key, value] of Object.entries(labels)) assert.equal(item.Config?.Labels?.[key], value, 'deployment_backup_helper_mismatch');
      assert.match(item.Id, /^[a-f0-9]{64}$/, 'deployment_backup_helper_mismatch');
      await deps.command(['rm', '--force', item.Id], { timeout: 30000 });
    }
  }
}

export async function coldDeploymentBackup(context, overrides = {}) {
  const deps = dependencies(overrides);
  const secrets = await preflightDeploymentBackup(context, deps);
  const { state } = context, expectedVolumes = resourceDefinitions(state).volumes;
  await mkdir(deps.backupRoot, { recursive: true, mode: 0o700 });
  await deps.protect(deps.backupRoot);
  const directory = join(deps.backupRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(6).toString('hex'));
  await mkdir(directory, { mode: 0o700 });
  await deps.protect(directory);
  const manifest = { version: 1, complete: false, installation: state.installation, revision: state.revision,
    createdAt: new Date().toISOString(), kind: 'stopped-volume-archives', secretValuesIncluded: false,
    requiresOriginalSwarmSecrets: secrets, volumes: [], files: [] };
  const publish = async () => {
    await writeFile(join(directory, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await rename(join(directory, 'manifest.json.tmp'), join(directory, 'manifest.json'));
  };
  await publish();
  manifest.files = await snapshotFiles(context, deps.sourceRoot, directory);
  for (const name of expectedVolumes) {
    assert.equal(await deps.command(['ps', '-q', '--filter', 'volume=' + name]), '', 'deployment_backup_volume_in_use:' + name);
    const args = backupVolumeArguments({ volume: name, directory, state }), file = name + '.tar.gz';
    // Pass only bounded fixed tar arguments to Node. Ownership returns to the host
    // operator so Linux backups are readable without making private files public.
    const commands = backupArchiveCommands(file);
    await runBackupHelper(args, commands.archive, state, deps);
    // Verification cannot modify the completed archive.
    const verifyArgs = args.map(value => value.endsWith(',target=/backup') ? value + ',readonly' : value);
    await runBackupHelper(verifyArgs, commands.verify, state, deps);
    manifest.volumes.push({ name, archive: file, ...await digestFile(join(directory, file)) });
    await publish();
  }
  manifest.complete = true; manifest.finishedAt = new Date().toISOString();
  await publish();
  console.log('冷备份完成：' + directory + '；Swarm Secret 保留于原节点，未导出其明文。');
  return directory;
}
