import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { piSource, validatePiSource, piBuildArguments } from './pi-runtime-build-config.mjs';
import { runWithKeepAlive } from './cli-keepalive.mjs';
import { prepareModelData } from './pi-runtime-model-data.mjs';

const exec = promisify(execFile);
export const piBuildRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const command = async (binary, args, options = {}) => (await exec(binary, args, {
  cwd: piBuildRoot, windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024, ...options,
})).stdout;

export async function inspectPiSource() {
  const git = async args => (await command('git', args)).trim();
  const gitlink = (await git(['ls-tree', 'HEAD', 'upstreams/pi'])).match(/^160000 commit ([a-f0-9]{40})\tupstreams\/pi$/)?.[1];
  const stagedGitlink = (await git(['ls-files', '--stage', '--', 'upstreams/pi'])).match(/^160000 ([a-f0-9]{40}) 0\tupstreams\/pi$/)?.[1];
  const packageBytes = await command('git', ['-C', 'upstreams/pi', 'show', piSource.commit + ':packages/coding-agent/package.json']);
  const lockBytes = await command('git', ['-C', 'upstreams/pi', 'show', piSource.commit + ':package-lock.json'], { encoding: 'buffer' });
  const source = { gitlink, stagedGitlink, head: await git(['-C', 'upstreams/pi', 'rev-parse', 'HEAD']),
    status: await git(['-C', 'upstreams/pi', 'status', '--porcelain', '--untracked-files=all']),
    version: JSON.parse(packageBytes).version, lockSha256: digest(lockBytes) };
  validatePiSource(source); return source;
}

export async function preparePiBuildContext({ builderOnly = false } = {}) {
  const source = await inspectPiSource();
  const context = await mkdtemp(join(tmpdir(), 'bairui-pi-f1-build-'));
  try {
    const archive = await command('git', ['-C', 'upstreams/pi', 'archive', '--format=tar', piSource.commit], { encoding: 'buffer' });
    if (archive.length > 64 * 1024 * 1024) throw new Error('pi_source_archive_oversized');
    await writeFile(join(context, 'pi-source.tar'), archive);
    const definition = join(piBuildRoot, 'apps/platform-api/docker/pi/production');
    await cp(join(definition, 'Dockerfile'), join(context, 'Dockerfile'));
    await cp(join(definition, 'dockerignore'), join(context, '.dockerignore'));
    const catalog = await prepareModelData({ output: join(context, 'model-data'), cache: join(piBuildRoot, 'output/pi-runtime/catalog') });
    await mkdir(join(context, 'production'));
    const wrapperHashes = {};
    const wrapperDirectory = join(piBuildRoot, 'apps/platform-api/src/runtime/pi/production');
    const entries = await readdir(wrapperDirectory).catch(error => { if (builderOnly && error.code === 'ENOENT') return []; throw error; });
    if (entries.length > 32) throw new Error('pi_wrapper_unbounded');
    for (const name of entries.sort()) {
      if (!/^[a-z][a-z-]*\.mjs$/.test(name)) throw new Error('pi_wrapper_file_invalid');
      const sourceFile = join(wrapperDirectory, name), stats = await lstat(sourceFile);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 256 * 1024) throw new Error('pi_wrapper_file_invalid');
      const bytes = await readFile(sourceFile); wrapperHashes[name] = digest(bytes);
      await writeFile(join(context, 'production', name), bytes);
    }
    if (!builderOnly && !wrapperHashes['index.mjs']) throw new Error('pi_wrapper_missing');
    const provenance = { sourceCommit: source.head, version: source.version, lockSha256: source.lockSha256,
      archiveSha256: digest(archive), baseImage: piSource.baseImage, modelCatalog: catalog,
      dockerfileSha256: digest(await readFile(join(context, 'Dockerfile'))),
      dockerignoreSha256: digest(await readFile(join(context, '.dockerignore'))), wrapperHashes };
    provenance.revision = digest(JSON.stringify(provenance)).slice(0, 20);
    await writeFile(join(context, 'provenance.json'), JSON.stringify(provenance, null, 2));
    return { context, provenance };
  } catch (error) { await rm(context, { recursive: true, force: true }); throw error; }
}

async function buildProcess(args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { cwd: piBuildRoot, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('pi_build_timeout')); }, 30 * 60 * 1000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolvePromise(); else reject(new Error('pi_build_failed')); });
  });
}

export async function buildPiRuntime({ builderOnly = false, platform = 'linux/amd64' } = {}) {
  // Never send an archive to a remote Docker endpoint by accident.
  const dockerContext = JSON.parse(await command('docker', ['context', 'inspect']))[0];
  if (process.env.DOCKER_HOST || !/^(npipe:\/\/|unix:\/\/)/.test(dockerContext?.Endpoints?.docker?.Host ?? '')) throw new Error('local_docker_required');
  const prepared = await preparePiBuildContext({ builderOnly });
  try {
    const tag = 'bairui/pi-runtime-f1:' + prepared.provenance.revision + (builderOnly ? '-builder' : '');
    await buildProcess(piBuildArguments({ context: prepared.context, tag, platform, target: builderOnly ? 'pi-builder' : undefined }));
    await inspectPiSource();
    const info = JSON.parse(await command('docker', ['image', 'inspect', tag]))[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(info?.Id ?? '') || info.Config.Labels?.['io.bairui.pi.source'] !== piSource.commit
      || info.Config.Labels?.['io.bairui.pi.lock'] !== piSource.lockSha256) throw new Error('pi_image_provenance_invalid');
    if (!builderOnly && (info.Config.User !== '1000:1000' || JSON.stringify(info.Config.Entrypoint)
      !== JSON.stringify(['node', '/app/pi/production/index.mjs', '--config', '/run/config/pi.json']))) throw new Error('pi_image_policy_invalid');
    const report = { ...prepared.provenance, platform, imageId: info.Id, repoDigests: info.RepoDigests, tag, builderOnly,
      builtAt: new Date().toISOString(), success: true };
    const output = join(piBuildRoot, 'output/pi-runtime/builds'); await mkdir(output, { recursive: true });
    const file = join(output, prepared.provenance.revision + (builderOnly ? '-builder' : '') + '.json');
    await writeFile(file, JSON.stringify(report, null, 2));
    console.log('F1 image:', tag, info.Id); console.log('F1 source evidence:', file); return report;
  } finally { await rm(prepared.context, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWithKeepAlive(async () => {
    const args = process.argv.slice(2);
    if (args.some(value => !['--builder-only', '--arm64', '--check'].includes(value))) throw new Error('pi_build_arguments_invalid');
    if (args.includes('--check')) { console.log(JSON.stringify(await inspectPiSource())); return; }
    await buildPiRuntime({ builderOnly: args.includes('--builder-only'), platform: args.includes('--arm64') ? 'linux/arm64' : 'linux/amd64' });
  }).catch(() => { console.error('F1 source build failed; inspect bounded build output.'); process.exitCode = 1; });
}
