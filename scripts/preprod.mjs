import { execFile } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { readFile, writeFile, readdir, mkdir, open, unlink, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stackConfig, gatewayConfig, bootstrapSql, assertOwned, assertLocalDocker, names, label, origin, apiImage, webImage, bootstrapName, missingDockerObject, dockerEndpoint } from './preprod-config.mjs';
import { monitorNames } from './monitoring-config.mjs';

// This entry point deliberately never loads .env or accepts a database URL.
export const root = fileURLToPath(new URL('../', import.meta.url));
export const output = join(root, 'output', 'preprod');
export const paths = { state: join(output, 'state.json'), ca: join(output, 'root.crt'), stack: join(output, 'stack.json') };
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|POSTGRES_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$)/.test(key)) delete childEnv[key];

export async function docker(args, { input, timeout = 120000, logFile, includeStderr = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = execFile('docker', args, { cwd: root, env: childEnv, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, async (error, stdout, stderr) => {
      if (logFile) await writeFile(logFile, stdout + '\n' + stderr).catch(() => {});
      if (!error) return resolveResult((stdout + (includeStderr ? '\n' + stderr : '')).trim());
      const safe = new Error('Docker 命令失败：' + args.slice(0, 2).join(' ') + (logFile ? '，请检查 ' + logFile : '（详细诊断请查看对应服务状态）'));
      safe.notFound = missingDockerObject(stderr);
      reject(safe);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function inspect(kind, name) {
  try { return JSON.parse(await docker([kind, 'inspect', name, '--format', '{{json .}}'])); }
  catch (error) { if (error.notFound) return null; throw error; }
}

export async function localDocker() {
  const endpoint = dockerEndpoint(childEnv, await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']));
  const info = JSON.parse(await docker(['info', '--format', '{"OSType":"{{.OSType}}","Swarm":{{json .Swarm}}}']));
  assertLocalDocker(info, endpoint);
  return { nodeId: info.Swarm.NodeID, endpoint };
}

export async function loadState() {
  let state;
  try { state = JSON.parse(await readFile(paths.state, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('预发状态文件损坏，请先检查 output/preprod/state.json，不要删除数据卷。'); }
  if (state.version !== 1 || !/^[a-f0-9]{24}$/.test(state.installation) || !/^[a-f0-9]{64}$/.test(state.schemaHash)) throw new Error('预发状态文件无效。');
  return state;
}
export async function saveState(state) {
  await writeFile(paths.state + '.tmp', JSON.stringify(state, null, 2) + '\n');
  await rename(paths.state + '.tmp', paths.state);
}

export async function withLock(action) {
  await mkdir(output, { recursive: true });
  const path = join(output, 'operation.lock');
  let lock;
  try { lock = await open(path, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(path, 'utf8'));
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (!Number.isInteger(pid) || pid < 1 || alive) throw new Error('另一个预发操作正在进行，或锁状态无法确认；请检查 output/preprod/operation.lock。');
    await unlink(path);
    lock = await open(path, 'wx');
  }
  await lock.writeFile(String(process.pid));
  try { return await action(); }
  finally { await lock.close(); await unlink(path); }
}

const labelsOf = (kind, item) => kind === 'container' || kind === 'image' ? item.Config?.Labels : item.Spec?.Labels ?? item.Labels;
export async function owned(kind, name, state) {
  const item = await inspect(kind, name);
  if (item) assertOwned(labelsOf(kind, item), state.installation);
  return item;
}

export async function checkResources(state) {
  for (const [kind, resources] of Object.entries({
    service: [names.api, names.db], container: [names.gateway],
    network: [names.edge, names.data], volume: [names.volume, names.caddyVolume],
    secret: [names.envSecret, names.adminSecret, names.appSecret], config: [bootstrapName(state.schemaHash)],
  })) for (const name of resources) await owned(kind, name, state);
}

export async function waitUntil(check, message, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(750);
  }
  throw new Error(message + '超时；环境保留，请运行 npm run preprod:status 检查。');
}

export async function containers(service, state) {
  const ids = (await docker(['ps', '-q', '--filter', 'label=com.docker.swarm.service.name=' + service])).split(/\s+/).filter(Boolean);
  const result = [];
  for (const id of ids) {
    const item = await owned('container', id, state);
    if (item) result.push(item);
  }
  return result;
}

export async function request(path, { method = 'GET', headers = {}, body, ca, timeout = 12000 } = {}) {
  ca ??= await readFile(paths.ca);
  return new Promise((resolveResult, reject) => {
    const req = httpsRequest(new URL(path, origin), { method, family: 4, ca, rejectUnauthorized: true,
      headers: { origin, ...headers }, timeout }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.length > 4 * 1024 * 1024) req.destroy(new Error('response_too_large')); });
      res.on('end', () => resolveResult({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function waitReady() {
  await waitUntil(async () => {
    try { const r = await request('/readyz', { timeout: 4000 }); return r.status === 200 && JSON.parse(r.text).database === 'postgres'; }
    catch { return false; }
  }, '平台就绪检查');
}

async function migrations() {
  const dir = join(root, 'packages', 'db', 'migrations');
  const files = [];
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) files.push({ name, sql: await readFile(join(dir, name), 'utf8') });
  return { files, hash: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
async function revision(state) {
  const hash = createHash('sha256').update(gatewayConfig(state));
  async function add(path) {
    const dir = await readdir(join(root, path), { withFileTypes: true });
    for (const entry of dir.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.env') || entry.name === 'node_modules') continue;
      const child = path + '/' + entry.name;
      if (entry.isDirectory()) await add(child);
      else if (entry.isFile()) hash.update(child).update(await readFile(join(root, child)));
    }
  }
  for (const dir of ['apps/platform-api/src', 'apps/console-mvp/src', 'apps/console-mvp/public', 'infra/preprod']) await add(dir);
  for (const file of ['apps/platform-api/Dockerfile', 'apps/platform-api/Dockerfile.dockerignore', 'apps/platform-api/package.json', 'apps/platform-api/package-lock.json',
    ...['package.json', 'package-lock.json', 'index.html', 'theme.css', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'vite.config.ts'].map(f => 'apps/console-mvp/' + f)]) hash.update(file).update(await readFile(join(root, file)));
  return hash.digest('hex').slice(0, 16);
}

async function freePort(port = 8443) {
  await new Promise((resolveResult, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error('本机 ' + port + ' 端口已占用，请确认占用者；不会停止其他服务。')));
    server.listen(port, '127.0.0.1', () => server.close(resolveResult));
  });
}

async function ensureSecrets(state) {
  const existing = await Promise.all([names.envSecret, names.adminSecret, names.appSecret].map(n => owned('secret', n, state)));
  if (existing.every(Boolean)) { state.secretsReady = true; await saveState(state); return; }
  if (existing.some(Boolean) || state.secretsReady || await owned('volume', names.volume, state)) {
    throw new Error('预发 Secret 不完整；已停止，绝不自动生成替代密码。请先保留现有卷和 Secret，再确认恢复方案。');
  }
  const adminPassword = randomBytes(32).toString('hex'), appPassword = randomBytes(32).toString('hex');
  const settings = {
    DATABASE_URL: 'postgresql://bairui_preprod_app:' + appPassword + '@' + names.db + ':5432/bairui_preprod',
    BAIRUI_SESSION_SECRET: randomBytes(48).toString('hex'), BETTER_AUTH_SECRET: randomBytes(48).toString('hex'),
  };
  for (const [name, value] of [[names.adminSecret, adminPassword], [names.appSecret, appPassword], [names.envSecret, JSON.stringify(settings)]]) {
    await docker(['secret', 'create', '--label', label + '=' + state.installation, name, '-'], { input: value });
  }
  state.secretsReady = true;
  await saveState(state);
}

async function pauseApi(state) {
  if (!await owned('service', names.api, state)) return;
  await docker(['service', 'scale', '--detach=true', names.api + '=0']);
  await waitUntil(async () => (await containers(names.api, state)).length === 0, 'API 停止');
}

export async function up() {
  console.log('启动本机常驻预发；不读取 .env，不连接 bairui 业务库。');
  const local = await localDocker(), schema = await migrations();
  let state = await loadState();
  if (!state) {
    state = { version: 1, installation: randomBytes(12).toString('hex'), nodeId: local.nodeId, endpoint: local.endpoint,
      schemaHash: schema.hash, createdAt: new Date().toISOString(), phase: 'initializing', secretsReady: false };
    await checkResources(state);
    await saveState(state);
  }
  if (state.nodeId !== local.nodeId || state.endpoint !== local.endpoint) throw new Error('Docker 节点或连接已变化，拒绝操作原预发数据卷。');
  if (state.schemaHash !== schema.hash) throw new Error('迁移文件已变化。现有预发数据库不会自动迁移；请先确认备份和迁移方案。');
  await checkResources(state);
  if (state.phase !== 'initializing') {
    for (const name of [names.volume, names.caddyVolume]) {
      if (!await owned('volume', name, state)) throw new Error('预发持久卷缺失：' + name + '。已停止；不会自动重建，请先确认数据恢复方案。');
    }
  }
  if (state.monitoring?.enabled) await (await import('./monitoring.mjs')).assertMonitoringResources(state);
  let gateway = await owned('container', names.gateway, state);
  if (!gateway?.State.Running) await freePort();
  if (state.monitoring?.enabled && (!gateway?.State.Running || !gateway.HostConfig?.PortBindings?.['9443/tcp'])) await freePort(9443);
  const rev = await revision(state);
  await writeFile(join(output, 'Caddyfile'), gatewayConfig(state));
  for (const [image, file, log] of [[apiImage(rev), 'apps/platform-api/Dockerfile', 'build-api.log'], [webImage(rev), 'infra/preprod/gateway.Dockerfile', 'build-web.log']]) {
    if (!await owned('image', image, state)) {
      console.log('构建预发镜像：' + image + '（进度写入 output/preprod/' + log + '）');
      await docker(['build', '--label', label + '=' + state.installation, '-t', image, '-f', file, '.'], { timeout: 600000, logFile: join(output, log) });
    }
  }
  await ensureSecrets(state);
  for (const name of [names.volume, names.caddyVolume]) {
    if (!await owned('volume', name, state)) await docker(['volume', 'create', '--label', label + '=' + state.installation, name]);
  }
  for (const name of [names.edge, names.data]) {
    const network = await owned('network', name, state);
    if (network && (network.Driver !== 'overlay' || !network.Attachable || network.Internal !== (name === names.data))) throw new Error('预发网络配置不匹配，拒绝继续。');
    if (!network) await docker(['network', 'create', '--driver', 'overlay', '--attachable', ...(name === names.data ? ['--internal'] : []), '--label', label + '=' + state.installation, name]);
  }
  const configName = bootstrapName(schema.hash);
  if (!await owned('config', configName, state)) await docker(['config', 'create', '--label', label + '=' + state.installation, configName, '-'], { input: bootstrapSql(schema.files, schema.hash) });
  if (!gateway || !gateway.State.Running || gateway.Config.Image !== webImage(rev)) {
    await pauseApi(state);
    if (gateway && gateway.Config.Image !== webImage(rev)) {
      await docker(['container', 'stop', '--time', '15', names.gateway]);
      await docker(['container', 'rm', names.gateway]);
      gateway = null;
    }
    if (gateway) await docker(['container', 'start', names.gateway]);
    else await docker(['run', '-d', '--name', names.gateway, '--label', label + '=' + state.installation,
      '--restart', 'unless-stopped', '--network', names.edge, '--memory', '128m', '--cpus', '0.25',
      '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true',
      '--tmpfs', '/config:rw,noexec,nosuid,size=8m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m',
      '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
      '--mount', 'type=volume,source=' + names.caddyVolume + ',target=/data', '-p', '127.0.0.1:8443:443',
      ...(state.monitoring?.enabled ? ['-p', '127.0.0.1:9443:9443'] : []), webImage(rev)]);
  }
  gateway = await owned('container', names.gateway, state);
  if (state.monitoring?.enabled && !gateway.NetworkSettings.Networks[monitorNames.network]) {
    await docker(['network', 'connect', monitorNames.network, names.gateway]);
    gateway = await owned('container', names.gateway, state);
  }
  const proxyIp = gateway.NetworkSettings.Networks[names.edge]?.IPAddress;
  const stack = stackConfig({ ...state, proxyIp, revision: rev });
  await writeFile(paths.stack, JSON.stringify(stack, null, 2) + '\n');
  await docker(['stack', 'config', '--compose-file', paths.stack]);
  console.log('部署双 API 和独立数据库，等待初始化与就绪……');
  await docker(['stack', 'deploy', '--detach=true', '--resolve-image', 'never', '--compose-file', paths.stack, names.stack]);
  await waitUntil(async () => {
    const rows = await containers(names.db, state);
    return rows.length === 1 && rows[0].State.Health?.Status === 'healthy';
  }, '数据库初始化', 240000);
  await waitUntil(async () => {
    const rows = await containers(names.api, state);
    return rows.length === 2 && rows.every(c => c.State.Health?.Status === 'healthy' && c.Config.Image === apiImage(rev));
  }, '双 API 启动');
  const cert = await waitUntil(async () => {
    try { return await docker(['exec', names.gateway, 'cat', '/data/caddy/pki/authorities/local/root.crt']); }
    catch { return false; }
  }, '本地证书生成');
  await writeFile(paths.ca, cert + '\n');
  await waitReady();
  state.phase = 'running'; state.revision = rev; state.proxyIp = proxyIp;
  state.certificateFingerprint = new X509Certificate(cert).fingerprint256;
  state.updatedAt = new Date().toISOString();
  await saveState(state);
  if (state.monitoring?.enabled) await (await import('./monitoring.mjs')).deployMonitoring(state);
  console.log('预发已就绪：' + origin + '，双 API / 独立 bairui_preprod。');
  console.log('公开 CA 证书：' + paths.ca + '；未修改 Windows 信任。');
}

export async function status() {
  const state = await loadState();
  if (!state) { console.log('尚未建立预发环境。运行 npm run preprod:up。'); return; }
  const local = await localDocker();
  if (local.nodeId !== state.nodeId || local.endpoint !== state.endpoint) throw new Error('当前 Docker 不是记录的预发节点。');
  await checkResources(state);
  console.log('环境：' + state.installation + ' | ' + origin + ' | 记录状态：' + state.phase);
  for (const name of [names.api, names.db]) {
    const service = await owned('service', name, state), rows = await containers(name, state);
    console.log(name + '：运行 ' + rows.length + ' / 期望 ' + (service?.Spec.Mode.Replicated.Replicas ?? 0) + '，健康 ' + rows.filter(c => c.State.Health?.Status === 'healthy').length + '，更新 ' + (service?.UpdateStatus?.State ?? '无'));
  }
  const gateway = await owned('container', names.gateway, state);
  console.log('Caddy：' + (gateway?.State.Status ?? '未创建') + '；数据卷和 Secret 不在停止时删除。');
  try { console.log('就绪探针：HTTP ' + (await request('/readyz', { timeout: 4000 })).status); }
  catch { console.log('就绪探针：不可用（停止状态或启动失败时属预期）'); }
}

export async function stop() {
  const state = await loadState();
  if (!state) { console.log('没有可停止的预发环境。'); return; }
  const local = await localDocker();
  if (local.nodeId !== state.nodeId || local.endpoint !== state.endpoint) throw new Error('当前 Docker 不是记录的预发节点。');
  await checkResources(state);
  if (state.monitoring?.enabled) await (await import('./monitoring.mjs')).stopMonitoringServices(state);
  if (await owned('container', names.gateway, state)) await docker(['container', 'stop', '--time', '15', names.gateway]);
  await pauseApi(state);
  if (await owned('service', names.db, state)) {
    await docker(['service', 'scale', '--detach=true', names.db + '=0']);
    await waitUntil(async () => (await containers(names.db, state)).length === 0, '数据库停止');
  }
  state.phase = 'stopped'; await saveState(state);
  console.log('预发已停止；账号、资源、数据卷、证书和 Secret 均保留。业务环境未操作。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  const action = { up, status, stop }[command];
  if (!action) { console.error('用法：node scripts/preprod.mjs up|status|stop'); process.exitCode = 1; }
  else await withLock(action).catch(error => { console.error(error.message); process.exitCode = 1; });
}
