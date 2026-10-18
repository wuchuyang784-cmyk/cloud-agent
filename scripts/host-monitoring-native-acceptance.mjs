import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { hostExporterImage, hostContainerArgs, hostCacheInitializationArgs, hostScrapeJob,
  assertNativeHost, assertHostMountPrerequisites, assertHostRootReadonly } from './host-monitoring-config.mjs';
import { hostDashboardExpressions } from '../apps/platform-api/src/admin/host-dashboard.mjs';

const exec = promisify(execFile), ownerLabel = 'bairui.m1-native.acceptance';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['scripts/host-monitoring-native-acceptance.mjs', 'scripts/host-monitoring-config.mjs',
  'apps/platform-api/src/admin/host-dashboard.mjs', 'apps/platform-api/src/observability/host-metrics-bridge.mjs'];
const prometheusImage = 'prom/prometheus:v3.14.0';
const argumentError = 'native_acceptance_arguments_invalid';
const linuxPath = value => {
  assert.ok(typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value) && !value.includes('..')
    && !value.includes('//') && !value.includes('/./'), argumentError);
  return value;
};
const apiRevision = value => { assert.match(value ?? '', /^[a-f0-9]{16}$/, argumentError); return value; };
const ownerId = value => { assert.match(value ?? '', /^[a-f0-9]{24}$/, argumentError); return value; };

export function parseNativeAcceptanceArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  assert.ok(args[0] === '--ssh' || args[0] === '--run-linux', argumentError);
  const mode = args[0] === '--ssh' ? 'ssh' : 'linux', values = new Map();
  const start = mode === 'ssh' ? 0 : 1;
  const allowed = mode === 'ssh' ? ['--ssh', '--project-root', '--api-revision', '--conda-path'] : ['--owner', '--output', '--api-revision'];
  for (let index = start; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    assert.ok(allowed.includes(key) && !values.has(key) && typeof value === 'string' && value.length > 0 && !value.startsWith('--'), argumentError);
    values.set(key, value);
  }
  const revision = apiRevision(values.get('--api-revision'));
  if (mode === 'linux') return { mode, owner: ownerId(values.get('--owner')), output: linuxPath(values.get('--output')), apiRevision: revision };
  const host = values.get('--ssh');
  assert.ok(typeof host === 'string' && /^(?:[A-Za-z_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(host), argumentError);
  return { mode, host, projectRoot: linuxPath(values.get('--project-root')), apiRevision: revision,
    condaPath: values.has('--conda-path') ? linuxPath(values.get('--conda-path')) : undefined };
}

export function nativeRemoteCommand({ condaPath, scriptPath, output, owner, apiRevision: revision }) {
  return `${linuxPath(condaPath)} run -n cloud --no-capture-output node ${linuxPath(scriptPath)} --run-linux --owner ${ownerId(owner)} --output ${linuxPath(output)} --api-revision ${apiRevision(revision)}`;
}

const usage = `Usage:
  node scripts/host-monitoring-native-acceptance.mjs --ssh <hostAliasOrUserHost> --project-root <absoluteLinuxPath> --api-revision <16hex> [--conda-path <absoluteCondaPath>]

All destination and revision arguments are required. Remote execution uses Conda environment cloud.
Without --conda-path, a read-only 'command -v conda' must discover an absolute executable path.
No environment, package, business .env, database or permanent service is installed or changed.
Reports and copied source hashes are saved under output/m1-native/<random-run>/.`;

async function command(binary, args, timeout = 30000) {
  try {
    const pending = exec(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    if (binary === 'ssh' && args.some(arg => arg.includes('--run-linux'))) pending.child.stdout.on('data', chunk => process.stdout.write(chunk));
    return (await pending).stdout.trim();
  }
  catch (error) { error.message = `${binary} ${args.slice(0, 3).join(' ')}: ${String(error.stderr || error.message).slice(0, 4000)}`; throw error; }
}
const docker = (args, timeout) => command('docker', args, timeout);
async function inspect(type, name, dockerImpl = docker) {
  try { return JSON.parse(await dockerImpl(['inspect', '--type', type, name]))[0]; }
  catch (error) { if (/No such (?:object|container|network|volume|image)|(?:network|volume) [a-z0-9_-]+ not found/i.test(error.message)) return null; throw error; }
}
export function checkHostMounts(text) {
  assertHostRootReadonly(text);
  return text.trim().split('\n').map(line => line.split(' - ')[0].split(' '))
    .filter(fields => fields[4] === '/host' || fields[4].startsWith('/host/'))
    .map(fields => ({ path: fields[4], options: fields[5] }));
}
export async function removeOwnedResource({ type, name, owner, docker: dockerImpl = docker }) {
  const item = await inspect(type, name, dockerImpl);
  if (!item) return;
  assert.equal((type === 'container' ? item.Config?.Labels : item.Labels)?.[ownerLabel], owner, 'acceptance_owner_mismatch');
  await dockerImpl(type === 'container' ? ['rm', '-f', item.Id] : [type, 'rm', item.Id ?? item.Name]);
}
async function waitFor(check, description, timeout = 90000) {
  const start = Date.now(); let last, progress = 0;
  while (Date.now() - start < timeout) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    if (Date.now() - progress >= 15000) { console.log(JSON.stringify({ waiting: description, elapsedMs: Date.now() - start })); progress = Date.now(); }
    await delay(1000);
  }
  throw new Error(description + ' timed out' + (last ? ': ' + last.message : ''));
}
async function freePort() {
  const server = createServer();
  await new Promise((yes, no) => { server.once('error', no); server.listen(19100, '127.0.0.1', yes); });
  await new Promise(resolve => server.close(resolve));
}

export async function runNative({ owner, output, apiRevision: revision }) {
  ownerId(owner); linuxPath(output); apiRevision(revision); assert.equal(process.platform, 'linux');
  const apiImage = 'bairui/platform-api-preprod:' + revision;
  const directory = dirname(resolve(output)); await mkdir(directory, { recursive: true });
  const prefix = 'bairui-m1-native-' + owner;
  const names = Object.fromEntries(['exporter', 'sampler', 'bridge', 'volume'].map(kind => [kind, prefix + '-' + kind]));
  const network = prefix + '-net', prometheus = prefix + '-prometheus', promVolume = prefix + '-promdata';
  const sourcePath = join(root, 'apps/platform-api/src/observability/host-metrics-bridge.mjs');
  const report = { version: 1, owner, startedAt: new Date().toISOString(), passed: false, checks: [], resources: { ...names, network, prometheus, promVolume } };
  const step = async (name, action) => {
    const started = Date.now();
    try { const evidence = await action(); const entry = { name, passed: true, elapsedMs: Date.now() - started, evidence }; report.checks.push(entry); console.log(JSON.stringify(entry)); return evidence; }
    catch (error) { report.checks.push({ name, passed: false, error: error.message }); throw error; }
  };
  const existing = (await docker(['ps', '--no-trunc', '--format', '{{.ID}}'])).split('\n').filter(Boolean).sort();
  report.existingBefore = existing;
  const ownedArgs = args => [args[0], '--label', ownerLabel + '=' + owner, ...args.slice(1)];
  const get = async (url, text = false) => JSON.parse(await docker(['exec', names.bridge, 'node', '-e',
    `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(5000)}).then(async r=>console.log(JSON.stringify({status:r.status,body:${text ? 'await r.text()' : 'await r.json()'}}))).catch(e=>{console.error(e.message);process.exitCode=1})`], 10000));
  const bridge = () => get('http://127.0.0.1:9100/metrics', true);
  const query = async expr => {
    const result = await get('http://' + prometheus + ':9090/api/v1/query?query=' + encodeURIComponent(expr));
    assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.status, 'success', JSON.stringify(result));
    return result.body.data.result;
  };
  const up = async expected => { const result = await query('up{job="bairui-host"}'); return result.length === 1 && Number(result[0].value[1]) === expected ? result : false; };
  try {
    await step('native_preflight', async () => {
      const info = JSON.parse(await docker(['info', '--format', '{{json .}}'])); assertNativeHost(process.platform, info);
      const kernel = await command('uname', ['-r']), mounts = await readFile('/proc/self/mountinfo', 'utf8'); assertHostMountPrerequisites(kernel, mounts);
      await freePort();
      const available = Number((await command('df', ['-B1', '--output=avail', '/var/lib/docker'])).split('\n').at(-1).trim());
      assert.ok(available > 1024 ** 3, 'one_GiB_free_disk_required_before_exporter_pull');
      assert.ok(await inspect('image', apiImage)); assert.ok(await inspect('image', prometheusImage));
      return { kernel, availableDiskBytes: available, existingContainerIds: existing, hostRoot: mounts.split('\n').find(line => line.split(' ')[4] === '/') };
    });
    await step('fixed_exporter_image', async () => {
      if (!await inspect('image', hostExporterImage)) await docker(['pull', hostExporterImage], 300000);
      const image = await inspect('image', hostExporterImage); assert.ok(image.RepoDigests.some(value => value.endsWith(hostExporterImage.split('@')[1])));
      return { requested: hostExporterImage, imageId: image.Id, repoDigests: image.RepoDigests };
    });
    await step('create_isolated_resources', async () => {
      for (const [type, name] of [['network', network], ['volume', names.volume], ['volume', promVolume], ...Object.values(names).filter(name => name !== names.volume).map(name => ['container', name]), ['container', prometheus]]) assert.equal(await inspect(type, name), null, 'temporary_name_must_be_unused');
      await docker(['network', 'create', '--internal', '--label', ownerLabel + '=' + owner, network]);
      for (const volume of [names.volume, promVolume]) await docker(['volume', 'create', '--label', ownerLabel + '=' + owner, volume]);
      for (const args of hostCacheInitializationArgs({ installation: owner, revision, volume: names.volume })) await docker(ownedArgs(args));
      return { network, cacheVolume: names.volume, prometheusVolume: promVolume, publishedPorts: [] };
    });
    const args = hostContainerArgs({ installation: owner, revision, sourcePath, names, network });
    await step('exporter_production_mount_and_recursive_readonly', async () => {
      await docker(ownedArgs(args.exporter));
      const item = await inspect('container', names.exporter);
      const mountinfo = await docker(['exec', names.exporter, '/bin/cat', '/proc/self/mountinfo']);
      await writeFile(join(directory, 'exporter-mountinfo.txt'), mountinfo + '\n');
      const hostMounts = checkHostMounts(mountinfo);
      assert.equal(item.HostConfig.NetworkMode, 'host'); assert.equal(item.HostConfig.PidMode, 'host');
      assert.equal(item.Mounts[0].Propagation, 'rslave'); assert.equal(item.Mounts[0].RW, false);
      return { containerId: item.Id, hostMountCount: hostMounts.length, allHostMountsReadonly: true, rootMount: hostMounts.find(row => row.path === '/host'), mount: item.Mounts[0] };
    });
    await step('sampler_bridge_and_private_prometheus', async () => {
      await docker(ownedArgs(args.sampler)); await docker(ownedArgs(args.bridge));
      const configPath = join(directory, 'prometheus.json');
      await writeFile(configPath, JSON.stringify({ global: { scrape_interval: '15s', scrape_timeout: '5s' }, scrape_configs: [hostScrapeJob()] }, null, 2));
      await docker(['run', '-d', '--pull=never', '--name', prometheus, '--label', ownerLabel + '=' + owner,
        '--network', network, '--user=65534:65534', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--pids-limit=64', '--memory=192m', '--cpus=0.30', '--init',
        '--mount', 'type=bind,source=' + configPath + ',target=/etc/prometheus/prometheus.json,readonly',
        '--mount', 'type=volume,source=' + promVolume + ',target=/prometheus', prometheusImage,
        '--config.file=/etc/prometheus/prometheus.json', '--storage.tsdb.retention.time=1h', '--storage.tsdb.retention.size=32MB']);
      const data = await waitFor(async () => { const result = await bridge(); return result.status === 200 && result; }, 'first fresh host sample');
      for (const name of [names.exporter, names.sampler, names.bridge, prometheus]) {
        const item = await inspect('container', name); assert.equal(item.Config.Labels[ownerLabel], owner);
        assert.equal(Object.keys(item.HostConfig.PortBindings ?? {}).length, 0); assert.equal(item.HostConfig.Privileged, false);
      }
      assert.equal((await inspect('network', network)).Internal, true);
      return { freshBridgeStatus: data.status, metricBytes: Buffer.byteLength(data.body), publishedPorts: [] };
    });
    await step('real_host_memory_and_prometheus_up', async () => {
      await waitFor(() => up(1), 'host scrape up=1');
      const hostBytes = Number((await readFile('/proc/meminfo', 'utf8')).match(/^MemTotal:\s+(\d+) kB/m)[1]) * 1024;
      const metric = await query('node_memory_MemTotal_bytes{job="bairui-host"}');
      assert.equal(metric.length, 1); assert.equal(Number(metric[0].value[1]), hostBytes);
      const exporterLimit = (await inspect('container', names.exporter)).HostConfig.Memory;
      assert.notEqual(hostBytes, exporterLimit, 'host memory must not be substituted with the container memory limit');
      return { hostProcMemTotalBytes: hostBytes, exportedMemTotalBytes: Number(metric[0].value[1]), exporterMemoryLimitBytes: exporterLimit, up: 1 };
    });
    await step('all_24_fixed_promql_queries_parse_and_cpu_rate_observed', async () => {
      assert.equal(hostDashboardExpressions.length, 24);
      const results = [];
      for (const [index, expr] of hostDashboardExpressions.entries()) results.push({ panel: index + 1, expr, resultSeries: (await query(expr)).length });
      await waitFor(async () => (await query(hostDashboardExpressions[4])).length > 0, 'real one-minute CPU counter rate');
      return results;
    });
    await step('exporter_failure_removes_sample_and_resources_then_recovers', async () => {
      await docker(['stop', '--time', '5', names.exporter]);
      await waitFor(async () => (await bridge()).status === 503, 'bridge503 after exporter stop', 45000);
      await waitFor(() => up(0), 'prometheus up0 after exporter stop', 45000);
      assert.deepEqual(await query(hostDashboardExpressions[5]), []);
      await docker(['start', names.exporter]);
      await waitFor(async () => (await bridge()).status === 200, 'fresh sample after exporter restart', 45000);
      await waitFor(() => up(1), 'prometheus recovery up1', 45000);
      assert.ok((await query(hostDashboardExpressions[5])).length > 0);
      return { failedBridge: 503, failedUp: 0, failedMemorySeries: 0, recoveredBridge: 200, recoveredUp: 1 };
    });
    await step('stopped_sampler_sample_expires_after_45_seconds_without_simulated_time', async () => {
      await waitFor(async () => {
        const current = await bridge();
        const timestamp = Number(current.body.match(/^bairui_host_metrics_sample_timestamp_seconds ([\d.]+)$/m)?.[1]) * 1000;
        return current.status === 200 && Date.now() - timestamp < 1500;
      }, 'new sample immediately before sampler stop', 25000);
      await docker(['stop', '--time', '5', names.sampler]);
      const latest = await bridge(); assert.equal(latest.status, 200);
      const sampledAt = Number(latest.body.match(/^bairui_host_metrics_sample_timestamp_seconds ([\d.]+)$/m)[1]) * 1000;
      const expiry = await waitFor(async () => { const current = await bridge(); return current.status === 503 && { observedAt: Date.now(), status: current.status }; }, 'actual45second sample expiry', 65000);
      assert.ok(expiry.observedAt - sampledAt > 45000);
      await waitFor(() => up(0), 'up0 after sampler expiry', 30000);
      for (const expr of hostDashboardExpressions.slice(3)) assert.deepEqual(await query(expr), [], expr);
      return { sampledAt, expiredAt: expiry.observedAt, sampleAgeAtExpiryMs: expiry.observedAt - sampledAt, bridgeStatus: 503, up: 0, emptyResourceQueries: hostDashboardExpressions.length - 3 };
    });
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    for (const name of [names.exporter, names.sampler, names.bridge, prometheus]) {
      try { const item = await inspect('container', name); if (item?.Config?.Labels?.[ownerLabel] === owner) await writeFile(join(directory, name + '.log'), await docker(['logs', '--tail', '60', item.Id])); } catch {}
    }
  } finally {
    const errors = [];
    for (const [type, name] of [['container', names.sampler], ['container', names.bridge], ['container', names.exporter], ['container', prometheus], ['volume', names.volume], ['volume', promVolume], ['network', network]]) {
      try { await removeOwnedResource({ type, name, owner }); } catch (error) { errors.push(error.message); }
    }
    try {
      const after = (await docker(['ps', '--no-trunc', '--format', '{{.ID}}'])).split('\n').filter(Boolean).sort(); report.existingAfter = after;
      assert.deepEqual(after, existing, 'existing_running_container_IDs_changed');
      const remaining = await docker(['ps', '-aq', '--filter', 'label=' + ownerLabel + '=' + owner]); assert.equal(remaining, '', 'temporary_containers_remaining');
    } catch (error) { errors.push(error.message); }
    report.cleanup = { passed: errors.length === 0, errors }; if (errors.length) report.passed = false;
    report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ finished: true, passed: report.passed, cleanup: report.cleanup, output }));
  }
  return report;
}

async function remoteRun({ host, projectRoot, apiRevision: revision, condaPath }) {
  const owner = randomBytes(12).toString('hex'), runName = new Date().toISOString().replace(/[:.]/g, '-') + '-' + owner.slice(0, 8);
  const directory = join(root, 'output', 'm1-native', runName), remoteDirectory = projectRoot.replace(/\/$/, '') + '/output/m1-native/' + runName;
  const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (!condaPath) {
    try { condaPath = linuxPath(await command('ssh', [...sshOptions, host, 'command -v conda'])); }
    catch { throw new Error('native_acceptance_remote_conda_not_found_supply_--conda-path'); }
  }
  await command('ssh', [...sshOptions, host, `${condaPath} run -n cloud --no-capture-output node --version`]);
  await mkdir(directory, { recursive: true });
  const manifest = { owner, host, remoteDirectory, apiRevision: revision, condaPath, files: [] };
  await command('ssh', [...sshOptions, host, `mkdir -p ${remoteDirectory}/source/scripts ${remoteDirectory}/source/apps/platform-api/src/admin ${remoteDirectory}/source/apps/platform-api/src/observability`]);
  for (const file of files) {
    const local = join(root, file), snapshot = join(directory, 'source', file);
    await mkdir(dirname(snapshot), { recursive: true }); await copyFile(local, snapshot);
    manifest.files.push({ path: file, sha256: createHash('sha256').update(await readFile(snapshot)).digest('hex') });
    await command('scp', [...sshOptions, snapshot, host + ':' + remoteDirectory + '/source/' + file]);
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  let failure;
  try {
    const remoteCommand = nativeRemoteCommand({ condaPath, scriptPath: remoteDirectory + '/source/scripts/host-monitoring-native-acceptance.mjs', output: remoteDirectory + '/report.json', owner, apiRevision: revision });
    const result = await command('ssh', [...sshOptions, host, remoteCommand], 600000);
    await writeFile(join(directory, 'execution.log'), result + '\n');
  } catch (error) { failure = error; console.error(error.message); }
  await command('scp', [...sshOptions, '-r', host + ':' + remoteDirectory + '/.', directory], 60000);
  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ localReport: join(directory, 'report.json'), passed: report.passed }));
  if (failure || !report.passed) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = async () => {
    const options = parseNativeAcceptanceArgs(process.argv.slice(2));
    if (options.mode === 'help') { console.log(usage); return; }
    if (options.mode === 'ssh') await remoteRun(options);
    else { const report = await runNative(options); if (!report.passed) process.exitCode = 1; }
  };
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
