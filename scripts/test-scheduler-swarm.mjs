import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForPostgres } from './postgres-ready.mjs';
import { serviceArgs, gatewayConfig, summarizeSamples, authRetryDelay } from './swarm-scheduler-config.mjs';

// Never load .env. Only resources recorded in this invocation may be removed.
const root = fileURLToPath(new URL('../', import.meta.url));
const { Client, Pool } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const exec = promisify(execFile);
const runId = 'bairui-swarm-check-' + randomBytes(5).toString('hex');
const names = { network: runId + '-net', db: runId + '-db', gateway: runId + '-gateway', api: runId + '-api', worker: runId + '-worker', secret: runId + '-env', config: runId + '-code' };
const image = 'bairui/scheduler-check:' + runId;
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|POSTGRES_)/.test(key)) delete env[key];
const resources = { services: [], containers: [], secrets: [], configs: [], networks: [], image: false };
let temp, admin, interrupted = false, monitoring = false, monitorPromise;
const report = { runId, startedAt: new Date().toISOString(), success: false, checks: [], resources: [] };
const samples = [], latencies = [], apiInstances = new Set(), workerInstances = new Set();
let sampledError;
process.once('SIGINT', () => { interrupted = true; });
process.once('SIGTERM', () => { interrupted = true; });

async function docker(args, { input, timeout = 120000, extraEnv = {} } = {}) {
  if (input === undefined) return (await exec('docker', args, { cwd: root, env: { ...env, ...extraEnv }, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, { cwd: root, env, windowsHide: true, timeout }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function waitUntil(check, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('check_interrupted');
    const result = await check();
    if (result) return result;
    await delay(250);
  }
  throw new Error(label + '_timeout');
}
const rows = async () => (await admin.query('SELECT id,user_id,status,attempt,"workerId","leaseUntil","createdAt","updatedAt" FROM simulation_tasks')).rows;
function passed(label) { report.checks.push(label); console.log('通过：' + label); }
let base;
async function request(path, { cookie, method = 'GET', body, key, expected = 200 } = {}, attempt = 0) {
  const started = performance.now();
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(15000),
    headers: { origin: base, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  latencies.push(performance.now() - started);
  const instance = response.headers.get('x-check-instance');
  if (instance) apiInstances.add(instance);
  const text = await response.text();
  const retryMs = authRetryDelay(path, response.status, response.headers.get('retry-after'), attempt);
  if (retryMs !== null) {
    report.authRateLimitWaits = (report.authRateLimitWaits ?? 0) + 1;
    console.log('账号准备触发限流，按 Retry-After 等待 ' + Math.ceil(retryMs / 1000) + ' 秒。');
    await delay(retryMs);
    return request(path, { cookie, method, body, key, expected }, attempt + 1);
  }
  if (response.status !== expected) {
    let code;
    try { const data = JSON.parse(text); code = data.code ?? data.error?.code; } catch {}
    report.httpFailure = { method, path, expected, actual: response.status, code };
  }
  assert.equal(response.status, expected, method + ' ' + path + ' expected_' + expected + '_got_' + response.status);
  return { body: text ? JSON.parse(text) : null, cookie: response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ') };
}
async function runningContainers(service) {
  const ids = (await docker(['ps', '-q', '--filter', 'label=com.docker.swarm.service.name=' + service])).split(/\s+/).filter(Boolean);
  return ids.length ? JSON.parse(await docker(['inspect', ...ids])).map(c => ({ id: c.Id, hostname: c.Config.Hostname })) : [];
}
async function stats(label) {
  const ids = [names.db, names.gateway, ...(await runningContainers(names.api)).map(c => c.id), ...(await runningContainers(names.worker)).map(c => c.id)];
  const raw = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids]);
  report.resources.push({ label, at: new Date().toISOString(), containers: raw.split('\n').filter(Boolean).map(s => {
    const row = JSON.parse(s);
    return { name: row.Name, cpu: row.CPUPerc, memory: row.MemUsage, memoryPercent: row.MemPerc, pids: row.PIDs };
  }) });
}

try {
  console.log('检查本机单节点 Swarm；本次不读取 .env，不连接 bairui 业务库。');
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
  assert.equal(info.Swarm.LocalNodeState, 'active', 'swarm_not_active');
  assert.equal(info.Swarm.ControlAvailable, true, 'swarm_manager_required');
  assert.equal(info.Swarm.Nodes, 1, 'this_check_requires_single_node_swarm');
  report.host = { dockerCPUs: info.NCPU, dockerMemoryBytes: info.MemTotal, swarmNodes: info.Swarm.Nodes };
  console.log('构建验收镜像（首次需要安装镜像内依赖）……');
  await docker(['build', '-f', 'apps/platform-api/Dockerfile', '-t', image, '.'], { timeout: 300000 });
  resources.image = true;
  await docker(['network', 'create', '--driver', 'overlay', '--attachable', names.network]);
  resources.networks.push(names.network);
  const password = randomBytes(24).toString('hex'), appPassword = randomBytes(24).toString('hex');
  await docker(['run', '-d', '--rm', '--name', names.db, '--network', names.network,
    '--memory', '512m', '--cpus', '1', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=scheduler_check',
    '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.2-pg17-bookworm'], { extraEnv: { POSTGRES_PASSWORD: password } });
  resources.containers.push(names.db);
  const dbInfo = JSON.parse(await docker(['inspect', names.db]))[0];
  const port = dbInfo.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const connectionString = 'postgresql://postgres:' + password + '@127.0.0.1:' + port + '/scheduler_check';
  await waitForPostgres(() => new Client({ connectionString, connectionTimeoutMillis: 2000, query_timeout: 2000 }));
  admin = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 3000 });
  const migrations = new URL('../packages/db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await admin.query(await readFile(new URL(file, migrations), 'utf8'));
  await admin.query("CREATE ROLE scheduler_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '" + appPassword + "'");
  await admin.query('GRANT CONNECT ON DATABASE scheduler_check TO scheduler_app');
  await admin.query('GRANT USAGE ON SCHEMA public TO scheduler_app');
  await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO scheduler_app');
  const role = (await admin.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='scheduler_app'")).rows[0];
  assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);

  temp = await mkdtemp(join(tmpdir(), runId + '-'));
  const caddyfile = join(temp, 'Caddyfile');
  await writeFile(caddyfile, gatewayConfig(names.api));
  await docker(['run', '-d', '--rm', '--name', names.gateway, '--network', names.network,
    '--memory', '128m', '--cpus', '0.25', '-p', '127.0.0.1::80',
    '--mount', 'type=bind,source=' + caddyfile + ',target=/etc/caddy/Caddyfile,readonly', 'caddy:2-alpine']);
  resources.containers.push(names.gateway);
  const gatewayInfo = JSON.parse(await docker(['inspect', names.gateway]))[0];
  base = 'http://127.0.0.1:' + gatewayInfo.NetworkSettings.Ports['80/tcp'][0].HostPort;
  const gatewayIP = gatewayInfo.NetworkSettings.Networks[names.network]?.IPAddress;
  assert.equal(isIP(gatewayIP ?? ''), 4, 'gateway_overlay_ip_missing');
  const emails = Array.from({ length: 10 }, (_, i) => 'swarm' + i + '@example.test');
  const settings = {
    NODE_ENV: 'test', BAIRUI_PLATFORM_MODE: 'platform', BAIRUI_AUTH_MODE: 'better-auth', BETTER_AUTH_URL: base,
    BAIRUI_TRUSTED_PROXIES: gatewayIP + '/32',
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), BAIRUI_SESSION_SECRET: randomBytes(32).toString('hex'),
    DATABASE_URL: 'postgresql://scheduler_app:' + appPassword + '@' + names.db + ':5432/scheduler_check',
    BAIRUI_SIMULATION_ENABLED: '1', BAIRUI_SIMULATION_USERS: emails.join(','),
  };
  await docker(['secret', 'create', names.secret, '-'], { input: JSON.stringify(settings) });
  resources.secrets.push(names.secret);
  await docker(['config', 'create', names.config, '-'], { input: await readFile(new URL('../infra/swarm/scheduler-check-entrypoint.mjs', import.meta.url), 'utf8') });
  resources.configs.push(names.config);
  for (const serviceRole of ['api', 'worker']) {
    await docker(serviceArgs({ name: names[serviceRole], image, network: names.network, secret: names.secret, config: names.config, role: serviceRole }));
    resources.services.push(names[serviceRole]);
  }
  await waitUntil(async () => {
    try {
      const response = await fetch(base + '/healthz', { signal: AbortSignal.timeout(1500) });
      return response.ok && (await response.json()).database === 'postgres';
    } catch { return false; }
  }, 'api_ready');
  for (const service of resources.services) await waitUntil(async () => (await runningContainers(service)).length === 2, 'two_replicas');
  const proxyProbe = await fetch(base + '/healthz', { signal: AbortSignal.timeout(5000) });
  await proxyProbe.arrayBuffer();
  report.proxy = { trustedGateway: gatewayIP, tcpPeer: proxyProbe.headers.get('x-check-peer'), clientIP: proxyProbe.headers.get('x-check-client-ip') };
  assert.equal(report.proxy.tcpPeer?.replace(/^::ffff:/, ''), gatewayIP, 'api_peer_must_be_exact_trusted_gateway');
  assert.notEqual(report.proxy.clientIP, report.proxy.tcpPeer, 'caddy_must_forward_client_address');
  passed('Swarm 双 API、双 Worker 启动，受限数据库角色，Caddy 仅监听本机');

  const users = [];
  for (const email of emails) {
    const password = randomBytes(20).toString('hex');
    const signup = await request('/api/auth/sign-up/email', { method: 'POST', body: { email, name: email, password } });
    assert.ok(signup.cookie, 'signup_cookie_missing');
    await request('/api/auth/sign-out', { method: 'POST', cookie: signup.cookie, body: {} });
    await request('/api/auth/me', { cookie: signup.cookie, expected: 401 });
    const login = await request('/api/auth/sign-in/email', { method: 'POST', body: { email, password } });
    assert.ok(login.cookie, 'login_cookie_missing');
    const me = await request('/api/auth/me', { cookie: login.cookie });
    users.push({ cookie: login.cookie, scope: me.body.user });
  }
  assert.equal(new Set(users.map(u => u.scope.organizationId)).size, 10);
  assert.equal((await admin.query('SELECT count(*) FROM ba_user')).rows[0].count, '10');
  assert.equal((await admin.query('SELECT count(*) FROM users')).rows[0].count, '10');
  await request('/api/simulation/tasks', { expected: 401 });
  // Reuse one session across independent API processes, not just different accounts.
  const sessionReplicas = new Set();
  await waitUntil(async () => {
    const response = await fetch(base + '/api/auth/me', { headers: { cookie: users[0].cookie }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.userId, users[0].scope.userId);
    sessionReplicas.add(response.headers.get('x-check-instance'));
    return sessionReplicas.size === 2 && !sessionReplicas.has(null);
  }, 'session_across_replicas', 15000);
  passed('10 用户真实注册、退出、重新登录；同一会话跨两份 API，个人空间独立');

  // Clear the last fixture login window without changing the provider's rules.
  await delay(10300);
  const authBurst = await Promise.all(Array.from({ length: 16 }, async (_, i) => {
    const response = await fetch(base + '/api/auth/sign-in/email', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { origin: base, 'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.' + (i + 1), 'x-real-ip': '203.0.113.' + (i + 1),
        'x-bairui-peer-ip': '203.0.113.' + (i + 1), forwarded: 'for=203.0.113.' + (i + 1) },
      body: JSON.stringify({ email: emails[0], password: 'wrong-password-for-check' }),
    });
    await response.arrayBuffer();
    return { status: response.status, retry: response.headers.get('retry-after'), instance: response.headers.get('x-check-instance') };
  }));
  assert.equal(authBurst.filter(r => r.status === 401).length, 3, 'auth_limit_shared_across_replicas');
  assert.equal(authBurst.filter(r => r.status === 429).length, 13, 'forwarded_headers_cannot_bypass_limit');
  assert.equal(new Set(authBurst.map(r => r.instance)).size, 2, 'auth_burst_must_hit_two_apis');
  for (const response of authBurst.filter(r => r.status === 429)) assert.ok(Number(response.retry) > 0 && Number(response.retry) <= 10, 'auth_retry_after_invalid');
  // A second real TCP client, not another forged forwarding header.
  const clientName = runId + '-client';
  const clientCode =     "const response = await fetch('http://' + process.env.CHECK_GATEWAY + '/api/auth/sign-in/email', {" +
    "method:'POST',headers:{origin:process.env.CHECK_ORIGIN,'content-type':'application/json','x-forwarded-for':'203.0.113.99'}," +
    "body:JSON.stringify({email:'swarm0@example.test',password:'wrong-password-for-check'})});" +
    "await response.arrayBuffer(); console.log(JSON.stringify({status:response.status}));";
  resources.containers.push(clientName);
  const secondClient = JSON.parse(await docker(['run', '--name', clientName, '--network', names.network,
    '--memory', '128m', '--cpus', '0.25', '--env', 'CHECK_GATEWAY=' + names.gateway, '--env', 'CHECK_ORIGIN=' + base,
    image, 'node', '--input-type=module', '-e', clientCode]));
  assert.equal(secondClient.status, 401, 'different_real_client_must_not_share_gateway_bucket');
  report.authRateLimit = { attempted: 16, admitted: 3, rejected: 13, apiReplicas: 2, distinctClientVerified: true };
  passed('Caddy 可信代理、双 API 共享认证限流，伪造头无法绕过，另一真实客户端不被连带限流');

  monitoring = true;
  monitorPromise = (async () => {
    while (monitoring) {
      const current = await rows();
      samples.push(current);
      for (const t of current) if (t.workerId) workerInstances.add(t.workerId);
      summarizeSamples([current]);
      await delay(200);
    }
  })().catch(error => { sampledError = error; });
  const started = performance.now();
  const submitted = await Promise.all(users.flatMap((user, i) => Array.from({ length: 5 }, async (_, j) => {
    const input = { durationMs: 2000 + j % 4 * 1000, outcome: 'success' };
    const result = await request('/api/simulation/tasks', { method: 'POST', cookie: user.cookie, key: 'load-' + j, body: input, expected: 201 });
    assert.equal(result.body.task.userId, user.scope.userId);
    return { userIndex: i, input, task: result.body.task };
  })));
  const first = submitted[0];
  const replay = await request('/api/simulation/tasks', { method: 'POST', cookie: users[0].cookie, key: 'load-0', body: first.input, expected: 201 });
  assert.equal(replay.body.task.id, first.task.id);
  await request('/api/simulation/tasks/' + first.task.id, { cookie: users[1].cookie, expected: 404 });
  await request('/api/simulation/tasks/' + first.task.id + '/cancel', { method: 'POST', cookie: users[1].cookie, expected: 404 });
  await stats('baseline-running');
  await waitUntil(async () => (await rows()).filter(t => t.status === 'succeeded').length === 50, 'baseline_tasks', 90000);
  const durationMs = performance.now() - started;
  for (const user of users) {
    const result = await request('/api/simulation/tasks', { cookie: user.cookie });
    assert.equal(result.body.tasks.length, 5);
    assert.ok(result.body.tasks.every(t => t.userId === user.scope.userId && t.status === 'succeeded'));
  }
  assert.equal(workerInstances.size, 2, 'both_workers_must_execute');
  assert.equal(apiInstances.size, 2, 'both_apis_must_serve');
  report.baseline = { users: 10, tasks: 50, durationMs: Math.round(durationMs), tasksPerSecond: Number((50000 / durationMs).toFixed(2)), apiReplicas: apiInstances.size, workerReplicas: workerInstances.size };
  passed('50 个任务全部完成，两份 Worker 实际执行；跨用户查询和取消均被拒绝');

  const faultTasks = await Promise.all(users.slice(0, 2).flatMap(user => Array.from({ length: 5 }, async (_, i) => (await request('/api/simulation/tasks', {
    cookie: user.cookie, method: 'POST', key: 'fault-' + i, body: { durationMs: 5000, outcome: 'success' }, expected: 201,
  })).body.task)));
  const faultIds = new Set(faultTasks.map(t => t.id));
  const running = await waitUntil(async () => {
    const active = (await rows()).filter(t => faultIds.has(t.id) && t.status === 'running');
    return new Set(active.map(t => t.workerId)).size === 2 ? active : false;
  }, 'fault_tasks_running');
  const victim = (await runningContainers(names.worker)).find(c => running.some(t => t.workerId === c.hostname));
  assert.ok(victim, 'owned_worker_not_found');
  const victimClaims = running.filter(t => t.workerId === victim.hostname);
  const killedAt = Date.now();
  await docker(['kill', '--signal=KILL', victim.id]);
  await waitUntil(async () => {
    const current = (await rows()).filter(t => faultIds.has(t.id));
    assert.ok(!current.some(t => t.status === 'failed'), 'fault_task_failed');
    return current.length === 10 && current.every(t => t.status === 'succeeded') ? current : false;
  }, 'worker_recovery', 90000);
  const recovered = (await rows()).filter(t => victimClaims.some(v => v.id === t.id) && t.attempt >= 2);
  assert.ok(recovered.length > 0, 'no_killed_task_was_retried');
  assert.ok(recovered.every(t => t.attempt <= 3));
  await waitUntil(async () => {
    const current = await runningContainers(names.worker);
    return current.length === 2 && current.every(c => c.id !== victim.id);
  }, 'worker_replaced');
  report.recovery = { signal: 'SIGKILL', submitted: 10, retried: recovered.length, durationMs: Date.now() - killedAt, replicasRestored: 2 };
  passed('真实 SIGKILL 中断 Worker，租约过期后任务重试完成，Swarm 恢复双副本');
  await stats('after-recovery');
  monitoring = false;
  await monitorPromise;
  if (sampledError) throw sampledError;
  report.concurrency = summarizeSamples(samples);
  const sorted = latencies.toSorted((a, b) => a - b);
  report.http = { requests: sorted.length, p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]), maxMs: Math.round(sorted.at(-1)) };
  report.success = true;
} catch (error) {
  // Do not serialize Docker errors: they may contain environment values or request bodies.
  report.error = error.code ?? error.name;
  if (error instanceof assert.AssertionError) report.failure = error.message.split('\n')[0];
  else if (/^[a-z_]+$/.test(error.message)) report.failure = error.message;
  console.error('Swarm 验收未完成：', report.failure ?? report.error);
  process.exitCode = 1;
} finally {
  monitoring = false;
  await monitorPromise;
  await admin?.end();
  const failures = [];
  async function remove(kind, name) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await docker([kind, 'rm', name], { timeout: 10000 }); return; }
      catch { await delay(500); }
    }
    failures.push(kind + ':' + name);
  }
  for (const name of resources.services) await remove('service', name);
  for (const name of resources.containers.reverse()) {
    try { await docker(['rm', '-f', '-v', name]); } catch { failures.push('container:' + name); }
  }
  for (const name of resources.secrets) await remove('secret', name);
  for (const name of resources.configs) await remove('config', name);
  for (const name of resources.networks) await remove('network', name);
  if (resources.image) await remove('image', image);
  if (temp) {
    assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
    assert.ok(basename(temp).startsWith(runId + '-'));
    await rm(temp, { recursive: true, force: true });
  }
  report.cleanup = { success: failures.length === 0, remaining: failures };
  if (failures.length) { process.exitCode = 1; report.success = false; console.error('需检查本次验收资源：', failures.join(', ')); }
  else console.log('本次验收服务、容器、网络、凭据已清理；业务环境未修改。');
  report.finishedAt = new Date().toISOString();
  const directory = join(root, 'output', 'scheduler-swarm');
  await mkdir(directory, { recursive: true });
  const path = join(directory, runId + '.json');
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
  console.log('验收报告：' + path);
  if (report.success) console.log('Swarm 验收通过：10 用户 / 50 基线任务 / 10 故障恢复任务。');
}
