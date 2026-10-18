import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rename, open, unlink, readdir, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, inspect, localDocker, loadState as loadPreprodState, waitUntil, root } from './preprod.mjs';
import { label as preprodLabel } from './preprod-config.mjs';
import { monitorNames } from './monitoring-config.mjs';
import { runtimeLabel, runtimeNames } from './runtime-deployment-config.mjs';
import { businessNames, businessLabel, businessKinds, businessVolumes, businessCredentials, businessImages, businessAssets,
  assertBusinessOwned, businessConnector, businessBridgeConfig, businessContainerArguments, businessValidationArguments, businessRevision } from './business-monitoring-config.mjs';
import { runWithKeepAlive } from './cli-keepalive.mjs';
import { monitoringPublicOrigin } from '../apps/platform-api/src/admin/monitoring-origin.mjs';

// Deliberately independent of the business .env, database credentials and preprod writes.
export const businessOutput = join(root, 'output', 'business-monitoring');
export const businessPaths = Object.freeze({ state: join(businessOutput, 'state.json'), connector: join(businessOutput, 'connector.json') });
const exec = promisify(execFile);
const privateAssets = () => [...Object.keys(businessAssets()), 'caddy.json', 'connector.json'];
// Schema 1 installations predate the additive host dashboard. Only this generated
// file may be absent during their first upgrade; published schema 2 requires it.
const assetsSchemaVersion = 2;

async function boundedRead(path, limit = 1024 * 1024) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat(); assert.ok(stat.isFile() && stat.size <= limit, 'business_file_invalid');
    const buffer = Buffer.alloc(limit + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    assert.ok(bytesRead <= limit, 'business_file_invalid');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
const defaults = { docker, inspect, directory: businessOutput, readFile: boundedRead, save: saveBusinessState };
const dependencies = overrides => ({ ...defaults, ...overrides });

function validateState(state) {
  assert.equal(state?.version, 1, 'business_state_invalid'); assert.match(state.installation, /^[a-f0-9]{24}$/, 'business_state_invalid');
  assert.ok(['initializing', 'running', 'stopped'].includes(state.phase), 'business_state_invalid');
  assert.ok(typeof state.endpoint === 'string' && typeof state.nodeId === 'string', 'business_state_invalid');
  for (const key of ['credentialsReady', 'assetsReady', 'resourcesReady']) assert.equal(typeof state[key], 'boolean', 'business_state_invalid');
  if (state.phase !== 'initializing') assert.ok(state.credentialsReady && state.assetsReady && state.resourcesReady, 'business_state_invalid');
  if (state.revision !== undefined) assert.match(state.revision, /^[a-f0-9]{16}$/, 'business_state_invalid');
  if (state.assetsPendingReconcile !== undefined) assert.equal(typeof state.assetsPendingReconcile, 'boolean', 'business_state_invalid');
  if (state.assetsSchemaVersion !== undefined) assert.ok([1, assetsSchemaVersion].includes(state.assetsSchemaVersion), 'business_state_invalid');
}

export async function loadBusinessState() {
  let state;
  try { state = JSON.parse(await boundedRead(businessPaths.state, 16384)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('business_state_invalid'); }
  validateState(state); return state;
}
export async function saveBusinessState(state) {
  validateState(state);
  const encoded = JSON.stringify(state, null, 2) + '\n'; assert.ok(Buffer.byteLength(encoded) <= 16384, 'business_state_too_large');
  await writeFile(businessPaths.state + '.tmp', encoded, { mode: 0o600 }); await rename(businessPaths.state + '.tmp', businessPaths.state);
}

export async function prepareBusinessDirectory() {
  await mkdir(businessOutput, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const account = (await exec('whoami', [], { windowsHide: true })).stdout.trim();
    await exec('icacls', [businessOutput, '/inheritance:r', '/grant:r', account + ':(OI)(CI)F', 'SYSTEM:(OI)(CI)F'], { windowsHide: true });
  }
}

export async function withBusinessLock(action) {
  await prepareBusinessDirectory();
  const path = join(businessOutput, 'operation.lock'); let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await boundedRead(path, 32)); let alive = true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    assert.ok(Number.isInteger(pid) && pid > 0 && !alive, 'business_operation_locked');
    await unlink(path); handle = await open(path, 'wx', 0o600);
  }
  await handle.writeFile(String(process.pid));
  try { return await action(); } finally { await handle.close(); await unlink(path); }
}

async function businessOwned(kind, name, state, deps) {
  const item = await deps.inspect(kind, name);
  if (item) {
    assert.ok(state, 'business_unrecorded_resource');
    assertBusinessOwned(kind === 'container' ? item.Config?.Labels : item.Labels, state.installation);
  }
  return item;
}

export async function assertBusinessResources(state, overrides) {
  const deps = dependencies(overrides), found = {};
  if (state) validateState(state);
  for (const [kind, names] of Object.entries({ container: businessKinds.map(k => businessNames[k]), network: [businessNames.network], volume: businessVolumes })) {
    for (const name of names) found[name] = await businessOwned(kind, name, state, deps);
  }
  const network = found[businessNames.network];
  if (network) assert.ok(network.Driver === 'bridge' && !network.Internal, 'business_network_configuration_invalid');
  if (state?.resourcesReady) for (const name of [businessNames.network, ...businessVolumes]) assert.ok(found[name], 'business_persistent_resource_missing:' + name);
  if (state?.credentialsReady || state?.resourcesReady) {
    for (const name of businessCredentials) {
      let value; try { value = (await deps.readFile(join(deps.directory, name), 65)).trim(); } catch { throw new Error('business_private_file_missing:' + name); }
      assert.match(value, /^[a-f0-9]{64}$/, 'business_credential_invalid');
    }
  }
  if (state?.assetsReady || state?.resourcesReady) for (const name of privateAssets()) {
    let value;
    try { value = await deps.readFile(join(deps.directory, name)); }
    catch (error) {
      if (name === 'dashboard-host.json' && error.code === 'ENOENT' && (state.assetsSchemaVersion ?? 1) === 1) {
        found.missingHostDashboard = true;
        continue;
      }
      throw new Error('business_private_file_missing:' + name);
    }
    if (name === 'connector.json') {
      try { assert.deepEqual(JSON.parse(value), businessConnector(state.installation, deps.directory, state.publicOrigin)); }
      catch { throw new Error('business_connector_invalid'); }
    }
  }
  return found;
}

export async function assertSharedMonitoring(preprod, runtimes, overrides) {
  const deps = dependencies(overrides);
  assert.match(preprod?.installation ?? '', /^[a-f0-9]{24}$/, 'business_preprod_state_invalid');
  const network = await deps.inspect('network', monitorNames.network);
  assert.equal(network?.Labels?.[preprodLabel], preprod.installation, 'business_shared_resource_owner_mismatch');
  assert.ok(network.Driver === 'overlay' && network.Internal && network.Attachable, 'business_shared_network_invalid');
  const alertmanager = await deps.inspect('service', monitorNames.alertmanager);
  assert.equal(alertmanager?.Spec?.Labels?.[preprodLabel], preprod.installation, 'business_shared_resource_owner_mismatch');
  const tokenFiles = {};
  for (const environment of ['business', 'preprod']) {
    const state = runtimes?.[environment];
    assert.equal(state?.version, 1, 'business_runtime_state_invalid'); assert.equal(state.environment, environment, 'business_runtime_state_invalid');
    assert.equal(state.phase, 'ready', 'business_runtime_state_invalid'); assert.match(state.installation, /^[a-f0-9]{24}$/, 'business_runtime_state_invalid');
    assert.equal(state.endpoint, preprod.endpoint, 'business_runtime_node_mismatch'); assert.equal(state.nodeId, preprod.nodeId, 'business_runtime_node_mismatch');
    const controller = await deps.inspect('container', runtimeNames(environment).controller);
    assert.equal(controller?.Config?.Labels?.[runtimeLabel], state.installation, 'business_runtime_owner_mismatch');
    assert.ok(controller.NetworkSettings?.Networks?.[monitorNames.network], 'business_runtime_monitor_network_missing');
    const tokenFile = join(root, 'output', 'runtime', environment, 'controller', 'metrics-token');
    const token = (await deps.readFile(tokenFile, 65)).trim(); assert.match(token, /^[a-f0-9]{64}$/, 'business_runtime_token_invalid');
    tokenFiles[environment] = tokenFile;
  }
  return tokenFiles;
}

export async function ensureBusinessResources(state, overrides) {
  const deps = dependencies(overrides), existing = await assertBusinessResources(state, deps);
  if (state.resourcesReady) return;
  assert.equal(state.credentialsReady, true, 'business_credentials_not_ready'); assert.equal(state.assetsReady, true, 'business_assets_not_ready');
  if (!existing[businessNames.network]) await deps.docker(['network', 'create', '--driver', 'bridge', '--label', businessLabel + '=' + state.installation, businessNames.network]);
  for (const [i, name] of businessVolumes.entries()) {
    if (!existing[name]) await deps.docker(['volume', 'create', '--label', businessLabel + '=' + state.installation, name]);
    // One-off initialization changes only the volume root owner, never its contents.
    await deps.docker(['run', '--rm', '--pull=never', '--network', 'none', '--label', businessLabel + '=' + state.installation,
      '--user=0:0', '--read-only', '--cap-drop=ALL', '--cap-add=CHOWN', '--security-opt=no-new-privileges:true', '--memory=64m', '--cpus=0.20', '--pids-limit=16',
      '--mount', 'type=volume,source=' + name + ',target=/data', '--entrypoint', '/bin/chown', businessImages.caddy, (i === 0 ? '65534:65534' : '472:472'), '/data']);
  }
  state.resourcesReady = true; await deps.save(state);
}

export async function reconcileBusinessContainer(kind, state, input, overrides) {
  assert.ok(businessKinds.includes(kind), 'invalid_business_monitoring_kind');
  const deps = dependencies(overrides), item = await businessOwned('container', businessNames[kind], state, deps);
  const environment = item?.Config?.Env ?? [];
  const matches = !input.assetsChanged && item?.Config?.Labels?.['bairui.business-monitoring.revision'] === input.revision
    && (kind !== 'grafana' || environment.includes('GF_AUTH_PROXY_WHITELIST=' + input.gatewayIp));
  if (item && matches) { if (!item.State.Running) await deps.docker(['start', item.Id]); return; }
  if (item) { if (item.State.Running) await deps.docker(['stop', '--time', '20', item.Id]); await deps.docker(['rm', item.Id]); }
  await deps.docker(businessContainerArguments(kind, { ...input, installation: state.installation, directory: deps.directory }));
}

export async function stopBusinessMonitoring(state, overrides) {
  const deps = dependencies(overrides), found = await assertBusinessResources(state, deps);
  for (const kind of businessKinds) {
    const item = found[businessNames[kind]]; if (item?.State.Running) await deps.docker(['stop', '--time', '20', item.Id]);
  }
  state.phase = 'stopped'; await deps.save(state);
}

async function machineContext() {
  const local = await localDocker(), preprod = await loadPreprodState();
  assert.ok(preprod, 'business_preprod_state_missing');
  assert.equal(local.endpoint, preprod.endpoint, 'business_docker_endpoint_mismatch'); assert.equal(local.nodeId, preprod.nodeId, 'business_docker_node_mismatch');
  const runtimes = {};
  for (const environment of ['business', 'preprod']) runtimes[environment] = JSON.parse(await boundedRead(join(root, 'output', 'runtime', environment, 'state.json'), 16384));
  const runtimeTokenFiles = await assertSharedMonitoring(preprod, runtimes);
  const state = await loadBusinessState();
  if (state) { assert.equal(state.endpoint, local.endpoint, 'business_docker_endpoint_mismatch'); assert.equal(state.nodeId, local.nodeId, 'business_docker_node_mismatch'); }
  await assertBusinessResources(state);
  return { local, state, runtimeTokenFiles };
}

async function ensureImages() {
  for (const image of Object.values(businessImages)) {
    const item = await inspect('image', image);
    if (!item) await docker(['pull', image], { timeout: 600000, logFile: join(businessOutput, 'pull-' + image.split('/').at(-1).replace(':', '-') + '.log') });
  }
}

export async function writeAssets(state, runtimeTokenFiles, overrides) {
  const deps = dependencies(overrides);
  const token = (await deps.readFile(join(deps.directory, 'bridge-token'), 65)).trim();
  const staged = await mkdtemp(join(deps.directory, '.assets-'));
  try {
    const changes = [];
    for (const [name, asset] of Object.entries({ ...businessAssets(), 'caddy.json': businessBridgeConfig(token), 'connector.json': businessConnector(state.installation, deps.directory, state.publicOrigin) })) {
      const value = JSON.stringify(asset, null, 2) + '\n';
      assert.ok(Buffer.byteLength(value) <= 1024 * 1024, 'business_asset_too_large');
      await writeFile(join(staged, name), value, { mode: 0o600, flag: 'wx' });
      let installed;
      try { installed = await deps.readFile(join(deps.directory, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (installed !== value) changes.push(name);
    }
    // Validators need their own private token copy; installed credentials never move.
    await writeFile(join(staged, 'metrics-token'), await deps.readFile(join(deps.directory, 'metrics-token'), 65), { mode: 0o600, flag: 'wx' });
    await validateBusinessAssets(runtimeTokenFiles, staged, deps);
    if (changes.length) {
      // Persist before publication: a crash after rename must still recreate bind mounts,
      // including repair of altered files when the container revision itself is unchanged.
      state.assetsPendingReconcile = true; await deps.save(state);
      if (deps.beforePublish) await deps.beforePublish();
      else {
        // Windows refuses atomic replacement while Docker holds a bind source open.
        // Inspect all ownership first, then release only this installation's mounts.
        const containers = [];
        for (const kind of businessKinds) containers.push(await businessOwned('container', businessNames[kind], state, deps));
        for (const item of containers) if (item?.State.Running) await deps.docker(['stop', '--time', '20', item.Id]);
      }
      for (const name of changes) await rename(join(staged, name), join(deps.directory, name));
    }
    state.assetsReady = true; state.assetsSchemaVersion = assetsSchemaVersion; await deps.save(state);
  } finally {
    assert.equal(dirname(resolve(staged)), resolve(deps.directory), 'business_staging_directory_invalid');
    await rm(staged, { recursive: true, force: true });
  }
}

export async function validateBusinessAssets(runtimeTokenFiles, directory = businessOutput, overrides) {
  // Official validators run before replacing any installed container.
  const deps = dependencies(overrides), input = { directory, runtimeTokenFiles };
  await deps.docker(businessValidationArguments('prometheus', input));
  await deps.docker(businessValidationArguments('prometheus', input, 'test'));
  await deps.docker(businessValidationArguments('caddy', input));
}

export async function businessUp() {
  const context = await machineContext(); let state = context.state;
  const publicOrigin = monitoringPublicOrigin(process.env.BAIRUI_BUSINESS_PUBLIC_ORIGIN ?? state?.publicOrigin);
  businessConnector(state?.installation ?? '0'.repeat(24), businessOutput, publicOrigin);
  if (state && publicOrigin !== monitoringPublicOrigin(state.publicOrigin)) throw new Error('business_public_origin_change_requires_explicit_migration');
  if (!state) {
    const entries = await readdir(businessOutput);
    assert.ok(entries.every(name => name === 'operation.lock'), 'business_unrecorded_private_files');
    state = { version: 1, installation: randomBytes(12).toString('hex'), phase: 'initializing', endpoint: context.local.endpoint, nodeId: context.local.nodeId,
      createdAt: new Date().toISOString(), credentialsReady: false, assetsReady: false, resourcesReady: false, assetsSchemaVersion, publicOrigin };
    await saveBusinessState(state);
    for (const name of businessCredentials) await writeFile(join(businessOutput, name), randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    state.credentialsReady = true; await saveBusinessState(state);
  }
  // Interrupted credentials are never silently regenerated.
  assert.equal(state.credentialsReady, true, 'business_credentials_incomplete');
  await assertBusinessResources(state);
  await ensureImages(); await writeAssets(state, context.runtimeTokenFiles); await ensureBusinessResources(state);
  const input = { revision: businessRevision(state.publicOrigin), publicOrigin: state.publicOrigin, runtimeTokenFiles: context.runtimeTokenFiles, assetsChanged: state.assetsPendingReconcile === true };
  await reconcileBusinessContainer('prometheus', state, input);
  let prometheus = await businessOwned('container', businessNames.prometheus, state, defaults);
  if (!prometheus.NetworkSettings.Networks[monitorNames.network]) await docker(['network', 'connect', monitorNames.network, prometheus.Id]);
  await reconcileBusinessContainer('caddy', state, input);
  const caddy = await businessOwned('container', businessNames.caddy, state, defaults);
  input.gatewayIp = caddy.NetworkSettings.Networks[businessNames.network]?.IPAddress;
  await reconcileBusinessContainer('grafana', state, input);
  await waitUntil(async () => {
    for (const kind of businessKinds) {
      const item = await businessOwned('container', businessNames[kind], state, defaults);
      if (!item?.State.Running || item.State.Health?.Status !== 'healthy') return false;
    }
    return true;
  }, '业务监控三个组件启动', 180000);
  state.phase = 'running'; state.revision = input.revision; state.gatewayIp = input.gatewayIp;
  delete state.assetsPendingReconcile; await saveBusinessState(state);
  console.log('业务监控已就绪；同源管理入口：' + publicOrigin + '/admin/。机器连接配置：' + businessPaths.connector);
  console.log('专用 bridge 允许出站以采集宿主 API；仅 Prometheus 接入现有监控 overlay，原预发服务和数据保持原配置。');
  return state;
}

export async function businessStatus() {
  const state = await loadBusinessState();
  if (!state) { console.log('业务监控尚未安装。'); return null; }
  const local = await localDocker(); assert.equal(local.endpoint, state.endpoint); assert.equal(local.nodeId, state.nodeId);
  const found = await assertBusinessResources(state);
  const statuses = businessKinds.map(kind => ({ component: kind, running: Boolean(found[businessNames[kind]]?.State.Running), health: found[businessNames[kind]]?.State.Health?.Status ?? 'absent' }));
  console.log('业务监控记录状态：' + state.phase); console.table(statuses); return statuses;
}
export async function businessStop() {
  const state = await loadBusinessState(); if (!state) { console.log('业务监控尚未安装。'); return; }
  const local = await localDocker(); assert.equal(local.endpoint, state.endpoint); assert.equal(local.nodeId, state.nodeId);
  await stopBusinessMonitoring(state); console.log('业务监控已停止；原数据卷、网络、凭据和预发服务保留。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = { up: businessUp, status: businessStatus, stop: businessStop }[process.argv[2]];
  if (!action) { console.error('用法：node scripts/business-monitoring.mjs up|status|stop'); process.exitCode = 1; }
  else runWithKeepAlive(() => process.argv[2] === 'status' ? action() : withBusinessLock(action)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
