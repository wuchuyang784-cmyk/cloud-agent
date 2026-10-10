import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, copyFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { docker, inspect, localDocker, loadState, saveState, owned, containers, withLock, waitUntil, root, paths } from './preprod.mjs';
import { names, apiImage, label as preprodLabel } from './preprod-config.mjs';
import { monitorNames } from './monitoring-config.mjs';
import { runtimeNames, runtimeLabel, controllerGrants, runtimeContainerArguments } from './runtime-deployment-config.mjs';
import { runWithKeepAlive } from './cli-keepalive.mjs';

const exec = promisify(execFile);
const base = join(root, 'output', 'runtime');
const envNames = ['business', 'preprod'];
const stateFile = environment => join(base, environment, 'state.json');
export async function loadRuntimeState(environment) {
  runtimeNames(environment);
  let state;
  try { state = JSON.parse(await readFile(stateFile(environment), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  assert.equal(state.version, 1); assert.equal(state.environment, environment);
  assert.match(state.installation, /^[a-f0-9]{24}$/);
  return state;
}
async function save(state) {
  const path = stateFile(state.environment);
  await writeFile(path + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(path + '.tmp', path);
}
export async function runtimeOwned(kind, name, state) {
  const item = await inspect(kind, name);
  if (item) assert.equal((kind === 'container' || kind === 'image' ? item.Config.Labels : item.Labels)?.[runtimeLabel], state.installation, 'runtime_resource_owner_mismatch');
  return item;
}
async function target(environment) {
  const n = runtimeNames(environment), preprod = await loadState();
  const local = await localDocker();
  assert.equal(local.nodeId, preprod.nodeId); assert.equal(local.endpoint, preprod.endpoint);
  if (environment === 'preprod') {
    const rows = await containers(names.db, preprod);
    assert.equal(rows.length, 1); return { id: rows[0].Id, user: 'postgres', n, preprod };
  }
  const c = await inspect('container', 'bairui-postgres');
  assert.equal(c?.Name, '/bairui-postgres'); assert.equal(c?.State.Running, true);
  const entries = Object.fromEntries(c.Config.Env.map(e => { const at = e.indexOf('='); return [e.slice(0, at), e.slice(at + 1)]; }));
  assert.equal(entries.POSTGRES_DB, 'bairui'); assert.equal(entries.POSTGRES_USER, 'bairui');
  return { id: c.Id, user: 'bairui', n, preprod };
}
export async function runtimeSql(environment, sql, database) {
  const t = await target(environment);
  // SQL and machine passwords use stdin; never shell args/log files.
  return docker(['exec', '-i', t.id, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', t.user, '-d', database ?? t.n.database, '-At'], { input: sql });
}
const countsSql = `SELECT json_build_object('users',(SELECT count(*) FROM users),'agents',(SELECT count(*) FROM agents),
'resources',(SELECT count(*) FROM client_resources),'engineRuns',(SELECT count(*) FROM agent_engine_runs),
'pendingOutbox',(SELECT count(*) FROM control_outbox WHERE status IN ('pending','processing')));`;

export async function backupRuntimeEnvironment(environment) {
  const t = await target(environment);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join(base, 'backups', environment + '-' + stamp);
  await mkdir(directory, { recursive: true });
  const suffix = randomBytes(6).toString('hex'), remote = '/tmp/bairui-e3-' + suffix;
  await docker(['exec', t.id, 'pg_dump', '-U', t.user, '-d', t.n.database, '-Fc', '-f', remote + '.dump']);
  const listing = await docker(['exec', t.id, 'pg_restore', '--list', remote + '.dump']);
  assert.ok(listing.includes('TABLE DATA public users') && listing.includes('TABLE DATA public agents'));
  await docker(['cp', t.id + ':' + remote + '.dump', join(directory, 'database.dump')]);
  await docker(['exec', t.id, 'pg_dumpall', '-U', t.user, '--roles-only', '-f', remote + '-roles.sql']);
  await docker(['cp', t.id + ':' + remote + '-roles.sql', join(directory, 'roles.sql')]);
  // Explicit files only, never remove database data or a computed directory.
  await docker(['exec', t.id, 'rm', '-f', remote + '.dump', remote + '-roles.sql']);
  const counts = JSON.parse(await runtimeSql(environment, countsSql));
  const volumes = (await inspect('container', t.id)).Mounts.map(m => ({ name: m.Name, source: m.Source, target: m.Destination }));
  await writeFile(join(directory, 'restore-list.txt'), listing);
  await writeFile(join(directory, 'inventory.json'), JSON.stringify({ environment, counts, volumes, preprod: t.preprod }, null, 2));
  if (environment === 'preprod') { await copyFile(paths.state, join(directory, 'preprod-state.json')); await copyFile(paths.ca, join(directory, 'root.crt')); }
  const metadata = { directory, counts, verified: true, createdAt: new Date().toISOString() };
  await writeFile(join(base, environment, 'backup.json'), JSON.stringify(metadata, null, 2));
  console.log(environment + ' 数据库备份已校验：' + directory);
  return metadata;
}
export async function prepareRuntimeDirectory() {
  await mkdir(base, { recursive: true });
  if (process.platform === 'win32') {
    const account = (await exec('whoami', [], { windowsHide: true })).stdout.trim();
    await exec('icacls', [base, '/inheritance:r', '/grant:r', account + ':(OI)(CI)F', 'SYSTEM:(OI)(CI)F'], { windowsHide: true });
  }
  for (const environment of envNames) await mkdir(join(base, environment), { recursive: true, mode: 0o700 });
}

export async function provisionRuntimeEnvironment(environment) {
  const t = await target(environment), n = t.n;
  const backup = JSON.parse(await readFile(join(base, environment, 'backup.json'), 'utf8'));
  assert.equal(backup.verified, true);
  let state = await loadRuntimeState(environment);
  if (state?.phase === 'ready') { console.log(environment + ' 已完成迁移和凭据配置，保留原安装。'); return state; }
  const directory = join(base, environment);
  if (!state) {
    // Existing unrecorded login/database must never be adopted or reset.
    const conflicts = await runtimeSql(environment, `SELECT count(*) FROM pg_roles WHERE rolname IN ('bairui_runtime_controller','bairui_runtime_ledger');
SELECT count(*) FROM pg_database WHERE datname='${n.ledger}';`);
    assert.equal(conflicts, '0\n0', 'runtime_database_or_role_unowned');
    state = { version: 1, environment, installation: randomBytes(12).toString('hex'), phase: 'initializing', backup: backup.directory,
      nodeId: t.preprod.nodeId, endpoint: t.preprod.endpoint, createdAt: new Date().toISOString() };
    await writeFile(join(directory, 'credentials.json'), JSON.stringify({ controller: randomBytes(32).toString('hex'), ledger: randomBytes(32).toString('hex'),
      hmac: randomBytes(48).toString('hex'), token: randomBytes(32).toString('hex') }), { mode: 0o600, flag: 'wx' });
    await save(state);
  }
  const credentials = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8'));
  assert.ok(Object.values(credentials).every(v => /^[a-f0-9]{64,96}$/.test(v)));
  const current = JSON.parse(await runtimeSql(environment, countsSql));
  assert.equal(current.pendingOutbox, 0, 'unexpected_pending_business_work');
  assert.equal(current.engineRuns, 0, 'existing_runtime_requires_explicit_reconciliation');
  const hasControl = await runtimeSql(environment, "SELECT to_regclass('public.agent_runtime_controls') IS NOT NULL;");
  if (hasControl === 'f') await runtimeSql(environment, await readFile(join(root, 'packages/db/migrations/039_runtime_control_fencing.sql'), 'utf8'));
  const hasSupervision = await runtimeSql(environment, "SELECT to_regprocedure('public.runtime_supervision_snapshot()') IS NOT NULL;");
  if (hasSupervision === 'f') await runtimeSql(environment, await readFile(join(root, 'packages/db/migrations/040_runtime_supervision.sql'), 'utf8'));
  const marker = 'bairui-runtime:' + state.installation;
  for (const [role, password] of [['bairui_runtime_controller', credentials.controller], ['bairui_runtime_ledger', credentials.ledger]]) {
    const present = await runtimeSql(environment, `SELECT coalesce(shobj_description(oid,'pg_authid'),'') FROM pg_roles WHERE rolname='${role}';`);
    const exists = await runtimeSql(environment, `SELECT count(*) FROM pg_roles WHERE rolname='${role}';`);
    if (exists === '1') assert.equal(present, marker, 'runtime_role_owner_mismatch');
    else await runtimeSql(environment, `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD '${password}'; COMMENT ON ROLE ${role} IS '${marker}';`);
  }
  const app = environment === 'business' ? 'bairui_app' : 'bairui_preprod_app';
  await runtimeSql(environment, `BEGIN; REVOKE ALL ON agent_runtime_controls,agent_runtime_control_requests FROM ${app};
GRANT CONNECT ON DATABASE ${n.database} TO bairui_runtime_controller;
${controllerGrants()} COMMIT;`);
  const ledgerExists = await runtimeSql(environment, `SELECT count(*) FROM pg_database WHERE datname='${n.ledger}';`);
  if (ledgerExists === '0') await runtimeSql(environment, `CREATE DATABASE ${n.ledger}; COMMENT ON DATABASE ${n.ledger} IS '${marker}';`);
  else assert.equal(await runtimeSql(environment, `SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='${n.ledger}';`), marker);
  const ledgerHasSchema = await runtimeSql(environment, "SELECT to_regclass('bairui_orchestrator.installation') IS NOT NULL;", n.ledger);
  if (ledgerHasSchema === 'f') await runtimeSql(environment, `BEGIN;
${await readFile(join(root, 'apps/platform-api/src/runtime/orchestrator/schema.sql'), 'utf8')}
INSERT INTO bairui_orchestrator.installation(installation_id) VALUES('${state.installation}');
REVOKE CONNECT ON DATABASE ${n.ledger} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${n.ledger} TO bairui_runtime_ledger;
GRANT USAGE ON SCHEMA bairui_orchestrator TO bairui_runtime_ledger;
GRANT SELECT ON bairui_orchestrator.installation TO bairui_runtime_ledger;
GRANT SELECT,INSERT,UPDATE ON bairui_orchestrator.runs TO bairui_runtime_ledger;
GRANT SELECT,INSERT,DELETE ON bairui_orchestrator.nonces TO bairui_runtime_ledger;
COMMIT;`, n.ledger);
  assert.equal(await runtimeSql(environment, 'SELECT installation_id FROM bairui_orchestrator.installation WHERE singleton;', n.ledger), state.installation);
  const nstate = { ...state };
  for (const network of [n.control, n.network]) {
    if (!await runtimeOwned('network', network, nstate)) await docker(['network', 'create', '--internal', '--label', runtimeLabel + '=' + state.installation,
      '--label', 'io.bairui.orchestrator.installation=' + state.installation, network]);
    const item = await runtimeOwned('network', network, nstate); assert.equal(item.Internal, true); assert.equal(item.Driver, 'bridge');
  }
  if (environment === 'business') {
    const db = await inspect('container', t.id);
    if (!db.NetworkSettings.Networks[n.control]) await docker(['network', 'connect', n.control, t.id]);
  }
  const image = (await inspect('image', 'node:22-alpine')).Id;
  const subnet = (await runtimeOwned('network', n.network, state)).IPAM.Config[0].Subnet;
  for (const kind of ['controller', 'orchestrator']) await mkdir(join(directory, kind, 'tls'), { recursive: true });
  const cert = join(directory, 'orchestrator', 'tls', 'cert.pem'), key = join(directory, 'orchestrator', 'tls', 'key.pem');
  let certificateExists = false;
  try { await readFile(cert); await readFile(key); certificateExists = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!certificateExists) await exec('openssl', ['req', '-config', join(root, 'apps/platform-api/test/helpers/orchestrator-tls.cnf'), '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '365', '-subj', '/CN=' + n.orchestrator, '-addext', 'subjectAltName=DNS:' + n.orchestrator + ',IP:127.0.0.1'], { windowsHide: true, timeout: 30000 });
  await copyFile(cert, join(directory, 'controller', 'tls', 'cert.pem'));
  await writeFile(join(directory, 'controller', 'metrics-token'), credentials.token, { mode: 0o600 });
  const common = { BAIRUI_RUNTIME_DEPLOYMENT: environment, BAIRUI_RUNTIME_INSTALLATION: state.installation,
    BAIRUI_RUNTIME_DATABASE_HOST: n.host, BAIRUI_RUNTIME_DATABASE_PORT: '5432', BAIRUI_RUNTIME_CONTROL_KEY_ID: 'managed-' + environment,
    BAIRUI_RUNTIME_CONTROL_SECRET: credentials.hmac };
  const controller = { ...common, BAIRUI_RUNTIME_CONTROLLER_MODE: 'managed',
    BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL: `postgresql://bairui_runtime_controller:${credentials.controller}@${n.host}:5432/${n.database}`,
    BAIRUI_RUNTIME_ORCHESTRATOR_URL: 'https://' + n.orchestrator + ':9494', BAIRUI_RUNTIME_ALLOWED_CIDRS: subnet,
    BAIRUI_RUNTIME_CONTROLLER_METRICS_TOKEN_FILE: '/config/metrics-token' };
  const orchestrator = { ...common, BAIRUI_ORCHESTRATOR_MODE: 'managed', BAIRUI_ORCHESTRATOR_INSTALLATION: state.installation,
    BAIRUI_ORCHESTRATOR_DATABASE_URL: `postgresql://bairui_runtime_ledger:${credentials.ledger}@${n.host}:5432/${n.ledger}`,
    BAIRUI_ORCHESTRATOR_NETWORK: n.network, BAIRUI_ORCHESTRATOR_IMAGE: image,
    BAIRUI_ORCHESTRATOR_TLS_KEY_FILE: '/config/tls/key.pem', BAIRUI_ORCHESTRATOR_TLS_CERT_FILE: '/config/tls/cert.pem' };
  await writeFile(join(directory, 'controller', 'controller.json'), JSON.stringify(controller), { mode: 0o600 });
  await writeFile(join(directory, 'orchestrator', 'orchestrator.json'), JSON.stringify(orchestrator), { mode: 0o600 });
  const existingSecret = await owned('secret', n.metricsSecret, t.preprod);
  if (!existingSecret) await docker(['secret', 'create', '--label', preprodLabel + '=' + t.preprod.installation,
    '--label', runtimeLabel + '=' + state.installation, n.metricsSecret, '-'], { input: credentials.token });
  else assert.equal(existingSecret.Spec.Labels[runtimeLabel], state.installation);
  state.phase = 'ready'; state.subnet = subnet; state.probeImage = image; state.preprodInstallation = t.preprod.installation;
  await save(state);
  console.log(environment + ' 039/040、受限角色和独立 ledger 已配置，未创建业务 Agent。');
  return state;
}

export async function buildRuntimeOrchestrator() {
  const content = await readFile(join(root, 'apps/platform-api/docker/orchestrator/Dockerfile'));
  const preprod = await loadState();
  const rev = createHash('sha256').update(content).update(preprod.revision).update(await readFile(join(root, 'apps/platform-api/package-lock.json'))).digest('hex').slice(0, 16);
  const tag = 'bairui/runtime-orchestrator:' + rev;
  const existing = await inspect('image', tag);
  if (existing) assert.equal(existing.Config.Labels?.['bairui.runtime.image-revision'], rev, 'runtime_image_owner_mismatch');
  else await docker(['build', '--file', 'apps/platform-api/docker/orchestrator/Dockerfile', '--label', 'bairui.runtime.image-revision=' + rev, '--tag', tag, '.'],
    { timeout: 600000, logFile: join(base, 'build-orchestrator.log') });
  return tag;
}
export async function startRuntimeEnvironment(environment, { rebuild = false } = {}) {
  const state = await loadRuntimeState(environment), t = await target(environment), n = t.n;
  assert.equal(state?.phase, 'ready', 'runtime_not_provisioned');
  assert.equal(state.nodeId, t.preprod.nodeId); assert.equal(state.endpoint, t.preprod.endpoint);
  assert.ok(await runtimeOwned('network', n.control, state), 'runtime_control_network_missing');
  assert.ok(await runtimeOwned('network', n.network, state), 'runtime_network_missing');
  assert.ok(await owned('secret', n.metricsSecret, t.preprod), 'runtime_metrics_secret_missing');
  for (const path of ['controller/controller.json', 'controller/metrics-token', 'controller/tls/cert.pem', 'orchestrator/orchestrator.json', 'orchestrator/tls/key.pem']) {
    assert.ok((await readFile(join(base, environment, path))).length, 'runtime_private_config_missing');
  }
  const orchImage = await buildRuntimeOrchestrator();
  for (const kind of ['orchestrator', 'controller']) {
    let item = await runtimeOwned('container', n[kind], state);
    const expected = kind === 'controller' ? apiImage(t.preprod.revision) : orchImage;
    if (item && (rebuild || item.Config.Image !== expected || item.HostConfig.Init !== true)) {
      await docker(['stop', '--time', '30', item.Id]); await docker(['rm', item.Id]); item = null;
    }
    if (!item) {
      // Create stopped first, attach required networks, then start: no failed-first-boot race.
      const args = runtimeContainerArguments(kind, { ...state, directory: join(base, environment).replaceAll('\\', '/'), apiImage: apiImage(t.preprod.revision), orchestratorImage: orchImage });
      args[0] = 'create'; args.splice(1, 1);
      await docker(args);
    }
    const current = await runtimeOwned('container', n[kind], state);
    for (const network of [n.control, ...(environment === 'preprod' ? [names.data] : []), kind === 'orchestrator' ? n.network : monitorNames.network]) {
      if (!current.NetworkSettings.Networks[network]) await docker(['network', 'connect', network, n[kind]]);
    }
    await docker(['start', n[kind]]);
    await waitUntil(async () => (await runtimeOwned('container', n[kind], state))?.State.Health?.Status === 'healthy', environment + ' ' + kind + '启动', 120000);
  }
  state.running = true; state.revision = t.preprod.revision; state.updatedAt = new Date().toISOString(); await save(state);
  console.log(environment + ' Controller/编排器常驻健康；未发布宿主端口。');
}
export async function assertRuntimeResources(environment, preprod) {
  const state = await loadRuntimeState(environment), n = runtimeNames(environment);
  assert.equal(state?.phase, 'ready', 'runtime_not_provisioned');
  assert.equal(state.nodeId, preprod.nodeId); assert.equal(state.endpoint, preprod.endpoint);
  if (environment === 'preprod') assert.equal(state.installation, preprod.runtime.installation, 'runtime_installation_mismatch');
  for (const network of [n.control, n.network]) assert.ok(await runtimeOwned('network', network, state), 'runtime_network_missing');
  assert.ok(await owned('secret', n.metricsSecret, preprod), 'runtime_metrics_secret_missing');
  for (const path of ['controller/controller.json', 'controller/metrics-token', 'controller/tls/cert.pem', 'orchestrator/orchestrator.json', 'orchestrator/tls/key.pem', 'orchestrator/tls/cert.pem']) {
    assert.ok((await readFile(join(base, environment, path))).length, 'runtime_private_config_missing');
  }
  for (const kind of ['controller', 'orchestrator']) await runtimeOwned('container', n[kind], state);
}
export async function stopRuntimeEnvironment(environment) {
  const state = await loadRuntimeState(environment); if (!state) throw new Error('runtime_state_missing');
  const n = runtimeNames(environment);
  for (const kind of ['controller', 'orchestrator']) {
    const item = await runtimeOwned('container', n[kind], state);
    if (!item) throw new Error('runtime_container_missing');
    await docker(['stop', '--time', '30', item.Id]);
  }
  state.running = false; await save(state);
}
export async function markPreprodRuntimeEnabled() {
  const p = await loadState();
  p.runtime = { enabled: true, environment: 'preprod', installation: (await loadRuntimeState('preprod')).installation };
  p.monitoring.runtime = { enabled: true, environments: envNames };
  await saveState(p);
}
export async function advancePreprodSchemaHash() {
  const p = await loadState(), files = [];
  for (const name of (await readdir(join(root, 'packages/db/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
    files.push({ name, sql: await readFile(join(root, 'packages/db/migrations', name), 'utf8') });
  }
  const prior = createHash('sha256').update(JSON.stringify(files.filter(f => !/^(039|040)_/.test(f.name)))).digest('hex');
  const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  assert.ok(p.schemaHash === prior || p.schemaHash === hash, 'unexpected_preprod_migration_baseline');
  assert.equal(await runtimeSql('preprod', "SELECT to_regprocedure('public.runtime_supervision_snapshot()') IS NOT NULL;"), 't');
  await runtimeSql('preprod', `INSERT INTO platform_ops.bootstrap(schema_hash) VALUES('${hash}') ON CONFLICT DO NOTHING;`);
  p.schemaHash = hash; await saveState(p);
}
export async function runtimeStatus(environment) {
  const state = await loadRuntimeState(environment);
  if (!state) { console.log(environment + ' 未安装'); return; }
  for (const kind of ['controller', 'orchestrator']) {
    const c = await runtimeOwned('container', runtimeNames(environment)[kind], state);
    console.log(environment + ' ' + kind + ': ' + (c?.State.Status ?? 'missing') + ' / ' + (c?.State.Health?.Status ?? 'unknown'));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, environment] = process.argv.slice(2);
  const actions = { backup: backupRuntimeEnvironment, provision: provisionRuntimeEnvironment, up: startRuntimeEnvironment, stop: stopRuntimeEnvironment, status: runtimeStatus };
  if (!actions[command] || !envNames.includes(environment)) { console.error('用法: node scripts/runtime-deployment.mjs backup|provision|up|stop|status business|preprod'); process.exitCode = 1; }
  else runWithKeepAlive(() => withLock(async () => { await prepareRuntimeDirectory(); await actions[command](environment); })).catch(e => { console.error(e.message); process.exitCode = 1; });
}
