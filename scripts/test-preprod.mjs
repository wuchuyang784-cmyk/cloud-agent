import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withLock, loadState, localDocker, owned, containers, docker, request, waitReady, waitUntil, output, stop, up } from './preprod.mjs';
import { names, origin, apiImage } from './preprod-config.mjs';
import { authRetryDelay } from './swarm-scheduler-config.mjs';

const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
const report = { runId, success: false, startedAt: new Date().toISOString(), checks: [] };
let state;
function passed(message) { report.checks.push(message); console.log('通过：' + message); }

async function api(path, { cookie, method = 'GET', body, expected = 200, headers = {} } = {}, attempt = 0) {
  const response = await request(path, { method, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const wait = authRetryDelay(path, response.status, response.headers['retry-after'] ?? null, attempt);
  if (wait !== null) { console.log('认证限流，按 Retry-After 等待 ' + Math.ceil(wait / 1000) + ' 秒。'); await delay(wait); return api(path, { cookie, method, body, expected, headers }, attempt + 1); }
  assert.equal(response.status, expected, method + ' ' + path + ' status');
  return { ...response, body: response.text ? JSON.parse(response.text) : null,
    cookie: (response.headers['set-cookie'] ?? []).map(c => c.split(';')[0]).join('; ') };
}

async function inApi(container, code, input = {}) {
  await owned('container', container.Id, state);
  const prefix = "const chunks=[]; for await(const c of process.stdin)chunks.push(c); const input=JSON.parse(Buffer.concat(chunks).toString()); ";
  return JSON.parse(await docker(['exec', '-i', container.Id, 'node', '--input-type=module', '-e', prefix + code], { input: JSON.stringify(input) }));
}
const meCode = "const r=await fetch('http://127.0.0.1:8080/api/auth/me',{headers:{cookie:input.cookie}});console.log(JSON.stringify({status:r.status,body:await r.json()}));";
async function acrossReplicas(user) {
  const rows = await containers(names.api, state);
  assert.equal(rows.length, 2);
  for (const container of rows) {
    const result = await inApi(container, meCode, { cookie: user.cookie });
    assert.equal(result.status, 200);
    assert.equal(result.body.user.userId, user.scope.userId);
  }
}

async function verify() {
  state = await loadState();
  if (!state || state.phase !== 'running') throw new Error('先运行 npm run preprod:up；验收只操作已归属的独立预发环境。');
  const local = await localDocker();
  assert.equal(local.nodeId, state.nodeId); assert.equal(local.endpoint, state.endpoint);
  await owned('service', names.api, state); await owned('service', names.db, state);
  const gateway = await owned('container', names.gateway, state);
  assert.equal(gateway.HostConfig.PortBindings['443/tcp'][0].HostIp, '127.0.0.1');
  assert.equal(gateway.HostConfig.PortBindings['443/tcp'][0].HostPort, '8443');
  for (const name of [names.api, names.db]) {
    const service = await owned('service', name, state);
    assert.equal(service.Spec.EndpointSpec?.Ports?.length ?? 0, 0);
  }
  await waitReady();
  console.log('开始常驻预发验收。会创建两名测试用户，并重启本环境 API/数据库；不操作 bairui 业务库。');
  const html = await request('/');
  assert.equal(html.status, 200); assert.match(html.headers['content-type'], /text\/html/);
  assert.ok(!html.text.includes('/@vite/client'));
  const asset = html.text.match(/src="([^"\s]+\.js)"/);
  assert.ok(asset, 'built_javascript_missing');
  const js = await request(asset[1]);
  assert.equal(js.status, 200); assert.match(js.headers['content-type'], /javascript/);
  assert.equal((await request('/assets/missing.js')).status, 404);
  const config = (await api('/api/auth/config')).body;
  assert.equal(config.provider, 'better-auth');
  assert.deepEqual(config.capabilities, { mode: 'platform', agentLifecycle: false, agentExecution: false, simulatedRecharge: false });
  await api('/api/user/resources', { expected: 401 });
  passed('受 CA 校验的 HTTPS、静态构建资源、仅回环入口、平台能力默认关闭');

  const users = [];
  for (let i = 0; i < 2; i++) {
    const email = 'preprod-' + runId.toLowerCase() + '-' + i + '@example.test', password = randomBytes(24).toString('hex');
    const signup = await api('/api/auth/sign-up/email', { method: 'POST', body: { email, password, name: '预发验收 ' + i } });
    const sessionCookie = signup.headers['set-cookie'].find(c => c.includes('session_token='));
    assert.ok(sessionCookie && /; Secure/i.test(sessionCookie) && /; HttpOnly/i.test(sessionCookie) && /; SameSite=Lax/i.test(sessionCookie));
    await api('/api/auth/sign-out', { method: 'POST', cookie: signup.cookie, body: {} });
    await api('/api/auth/me', { cookie: signup.cookie, expected: 401 });
    const login = await api('/api/auth/sign-in/email', { method: 'POST', body: { email, password },
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9', 'x-bairui-peer-ip': '203.0.113.9' } });
    const user = { cookie: login.cookie, scope: (await api('/api/auth/me', { cookie: login.cookie })).body.user };
    users.push(user);
    await acrossReplicas(user);
  }
  assert.notEqual(users[0].scope.organizationId, users[1].scope.organizationId);
  passed('两名真实注册用户、退出后失效、重新登录，同一会话直连两份 API 均有效');

  const resource = (await api('/api/user/resources', { method: 'POST', cookie: users[0].cookie, expected: 201,
    body: { kind: 'skill', name: '预发持久化验收 ' + runId, config: { runId }, ownerUserId: users[1].scope.userId, organizationId: users[1].scope.organizationId } })).body.resource;
  assert.equal(resource.ownerUserId, users[0].scope.userId);
  assert.equal(resource.organizationId, users[0].scope.organizationId);
  for (const method of ['GET', 'PATCH', 'DELETE']) await api('/api/user/resources/' + resource.id, { method, cookie: users[1].cookie, expected: 404, ...(method === 'PATCH' ? { body: { name: 'forbidden' } } : {}) });
  const otherResources = (await api('/api/user/resources', { cookie: users[1].cookie })).body.resources;
  assert.ok(!otherResources.some(r => r.id === resource.id));
  for (const path of ['/api/user/agents', '/api/user/agents/history/start', '/api/user/agents/history/stop', '/api/user/agents/history/sessions', '/api/user/billing/recharge']) {
    const denied = await api(path, { method: 'POST', cookie: users[0].cookie, body: {}, expected: 403 });
    assert.equal(denied.body.error.code, 'capability_disabled');
  }
  await api('/api/simulation/tasks', { cookie: users[0].cookie, expected: 404 });
  const [firstApi] = await containers(names.api, state);
  const security = await inApi(firstApi, `
    const {readFile}=await import('node:fs/promises');const {Pool}=await import('pg');
    const settings=JSON.parse(await readFile('/run/secrets/platform-env','utf8'));
    const pool=new Pool({connectionString:settings.DATABASE_URL,max:1});
    try {
      const role=(await pool.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
      const unscoped=(await pool.query('SELECT count(*) AS count FROM client_resources')).rows[0].count;
      const ips=(await pool.query('SELECT s."ipAddress" FROM ba_session s JOIN ba_user u ON s."userId"=u.id WHERE u.email LIKE $1',[input.prefix+'%'])).rows.map(r=>r.ipAddress);
      console.log(JSON.stringify({role,unscoped,ips}));
    } finally {await pool.end();}
  `, { prefix: 'preprod-' + runId.toLowerCase() });
  assert.deepEqual(security.role, { rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
  assert.equal(security.unscoped, '0');
  assert.equal(security.ips.length, 2);
  assert.ok(security.ips.every(ip => ip && ip !== '203.0.113.9' && ip.replace(/^::ffff:/, '') !== state.proxyIp));
  passed('受限数据库角色、无 scope 的 RLS、跨用户读写删除 404、伪造代理头无效、Agent/模拟入口关闭');

  const before = (await containers(names.api, state)).map(c => c.Id);
  await docker(['service', 'update', '--detach=true', '--force', names.api]);
  await waitUntil(async () => {
    const rows = await containers(names.api, state);
    return rows.length === 2 && rows.every(c => !before.includes(c.Id) && c.State.Health?.Status === 'healthy' && c.Config.Image === apiImage(state.revision));
  }, 'API 滚动重建');
  await waitReady();
  await acrossReplicas(users[0]);
  assert.equal((await api('/api/user/resources/' + resource.id, { cookie: users[0].cookie })).body.resource.id, resource.id);
  passed('两份 API 滚动重建后，原会话和资源仍然有效');

  const runningApis = (await containers(names.api, state)).map(c => c.Id).sort();
  const oldDb = (await containers(names.db, state))[0].Id;
  try {
    await docker(['service', 'scale', '--detach=true', names.db + '=0']);
    await waitUntil(async () => (await containers(names.db, state)).length === 0, '数据库暂时停止');
    for (const container of await containers(names.api, state)) {
      const probes = await inApi(container, "const results=[];for(const path of ['/livez','/readyz']){const r=await fetch('http://127.0.0.1:8080'+path);await r.text();results.push(r.status);}console.log(JSON.stringify(results));");
      assert.deepEqual(probes, [200, 503]);
    }
  } finally { await docker(['service', 'scale', '--detach=true', names.db + '=1']); }
  await waitUntil(async () => {
    const rows = await containers(names.db, state);
    return rows.length === 1 && rows[0].Id !== oldDb && rows[0].State.Health?.Status === 'healthy';
  }, '数据库恢复');
  await waitReady();
  assert.deepEqual((await containers(names.api, state)).map(c => c.Id).sort(), runningApis, 'database_disconnect_must_not_crash_apis');
  await acrossReplicas(users[0]);
  assert.equal((await api('/api/user/resources/' + resource.id, { cookie: users[0].cookie })).body.resource.id, resource.id);
  passed('数据库停机期间就绪 503、存活 200；数据库容器重建后 API 未崩溃，账号/会话/资源保留');

  const secretIds = await Promise.all([names.envSecret, names.appSecret, names.adminSecret].map(async name => (await owned('secret', name, state)).ID));
  await stop();
  await up();
  state = await loadState();
  assert.deepEqual(await Promise.all([names.envSecret, names.appSecret, names.adminSecret].map(async name => (await owned('secret', name, state)).ID)), secretIds);
  await acrossReplicas(users[0]);
  assert.equal((await api('/api/user/resources/' + resource.id, { cookie: users[0].cookie })).body.resource.id, resource.id);
  await api('/api/user/resources/' + resource.id, { cookie: users[1].cookie, expected: 404 });
  passed('完整 stop/up 保留 Secret、证书、账号和资源，恢复后仍然保持用户隔离');
  report.success = true;
  report.installation = state.installation;
  report.revision = state.revision;
  report.url = origin;
  report.testUsers = 2;
  report.testResourceId = resource.id;
}

await withLock(async () => {
  try { await verify(); }
  catch (error) { report.error = error.message; console.error('验收失败：' + error.message); process.exitCode = 1; }
  finally {
    report.finishedAt = new Date().toISOString();
    const file = join(output, 'acceptance-' + runId + '.json');
    await writeFile(file, JSON.stringify(report, null, 2) + '\n');
    console.log('脱敏验收报告：' + file + '。预发环境和测试数据保留。');
  }
}).catch(error => { console.error(error.message); process.exitCode = 1; });
