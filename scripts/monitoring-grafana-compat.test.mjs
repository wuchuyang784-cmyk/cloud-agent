import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { gatewayConfig } from './preprod-config.mjs';

const suffix = randomBytes(6).toString('hex');
const names = { network: 'bairui-grafana-compat-' + suffix, auth: 'bairui-auth-compat-' + suffix,
  caddy: 'bairui-caddy-compat-' + suffix, grafana: 'bairui-grafana-compat-' + suffix };
const apiImage = 'bairui/platform-api-preprod:13b3fb4e7579ed38';
const caddyImage = 'caddy:2.10.2-alpine';
const grafanaImage = 'grafana/grafana:13.2.2';

function docker(args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => execFile('docker', args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout, stderr) => {
    if (error) { error.message += '\n' + stderr; reject(error); } else resolve((stdout + (args[0] === 'logs' ? stderr : '')).trim());
  }));
}
async function freePort() {
  return await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
async function waitFor(url, predicate, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) }); if (predicate(response)) return response; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('compatibility_service_timeout: ' + url);
}
const directory = await mkdtemp(join(tmpdir(), 'bairui-grafana-compat-'));
try {
  const port = await freePort();
  const productionCaddyfile = join(directory, 'ProductionCaddyfile');
  await writeFile(productionCaddyfile, gatewayConfig({ monitoring: { enabled: true } }), 'utf8');
  await docker(['run', '--rm', '--mount', 'type=bind,source=' + productionCaddyfile + ',target=/etc/caddy/Caddyfile,readonly', caddyImage,
    'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  const caddyfile = join(directory, 'Caddyfile');
  await writeFile(caddyfile, `{
  admin off
  auto_https off
}
:8080 {
  header Content-Security-Policy "frame-ancestors http://localhost:8443"
  request_header -X-Bairui-Monitor-User
  request_header -X-Bairui-Monitor-Role
  @emergencyLogin path /login /login/* /logout
  handle @emergencyLogin {
    reverse_proxy grafana:3000 {
      header_up -X-Bairui-Monitor-User
    }
  }
  @emergencyPublic path /public/* /robots.txt /favicon.ico
  handle @emergencyPublic {
    reverse_proxy grafana:3000 {
      header_up -X-Bairui-Monitor-User
      header_up -X-Bairui-Monitor-Role
      header_up -Cookie
      header_up -Authorization
      header_down -Set-Cookie
    }
  }
  @emergencySession header_regexp grafanaSession Cookie "(?i)(^|;\\s*)grafana_session="
  handle @emergencySession {
    reverse_proxy grafana:3000 {
      header_up -X-Bairui-Monitor-User
    }
  }
  handle {
    forward_auth auth:8080 {
      uri /api/admin/monitoring/access
      copy_headers X-Bairui-Monitor-User X-Bairui-Monitor-Role
    }
    reverse_proxy grafana:3000 {
      header_up -Cookie
      header_up -Authorization
      header_down -Set-Cookie
    }
  }
}
`, 'utf8');
  await docker(['network', 'create', names.network]);
  const authCode = `import{createServer}from'node:http';createServer((q,s)=>{if(q.url==='/api/admin/monitoring/access'&&q.headers.cookie?.includes('platform=valid')){s.writeHead(204,{'X-Bairui-Monitor-User':'bairui:test-user','X-Bairui-Monitor-Role':'Viewer'});s.end()}else{s.writeHead(403);s.end()}}).listen(8080,'0.0.0.0')`;
  await docker(['run', '-d', '--name', names.auth, '--network', names.network, '--network-alias', 'auth', '--read-only', '--cap-drop', 'ALL', apiImage,
    'node', '--input-type=module', '-e', authCode]);
  await docker(['run', '-d', '--name', names.caddy, '--network', names.network, '--network-alias', 'caddy', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE',
    '--tmpfs', '/config', '--tmpfs', '/data', '-p', '127.0.0.1:' + port + ':8080', '--mount', 'type=bind,source=' + caddyfile + ',target=/etc/caddy/Caddyfile,readonly', caddyImage]);
  await new Promise(resolve => setTimeout(resolve, 500));
  if (await docker(['inspect', '-f', '{{.State.Running}}', names.caddy]) !== 'true') throw new Error('caddy_start_failed');
  const caddyIp = await docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', names.caddy]);
  await docker(['run', '-d', '--name', names.grafana, '--network', names.network, '--network-alias', 'grafana', '--read-only', '--cap-drop', 'ALL', '--tmpfs', '/var/lib/grafana', '--tmpfs', '/tmp',
    '-e', 'GF_SERVER_ROOT_URL=http://localhost:' + port, '-e', 'GF_SECURITY_ADMIN_USER=admin', '-e', 'GF_SECURITY_ADMIN_PASSWORD=compat-admin-secret',
    '-e', 'GF_AUTH_ANONYMOUS_ENABLED=false', '-e', 'GF_USERS_ALLOW_SIGN_UP=false', '-e', 'GF_AUTH_PROXY_ENABLED=true',
    '-e', 'GF_AUTH_PROXY_HEADER_NAME=X-Bairui-Monitor-User', '-e', 'GF_AUTH_PROXY_HEADER_PROPERTY=username', '-e', 'GF_AUTH_PROXY_AUTO_SIGN_UP=true',
    '-e', 'GF_AUTH_PROXY_ENABLE_LOGIN_TOKEN=false', '-e', 'GF_AUTH_PROXY_HEADERS=Role:X-Bairui-Monitor-Role', '-e', 'GF_AUTH_PROXY_SYNC_TTL=0',
    '-e', 'GF_AUTH_PROXY_WHITELIST=' + caddyIp, '-e', 'GF_USERS_AUTO_ASSIGN_ORG_ROLE=Viewer',
    '-e', 'GF_SECURITY_ALLOW_EMBEDDING=true', '-e', 'GF_ANALYTICS_REPORTING_ENABLED=false', grafanaImage]);
  const origin = 'http://127.0.0.1:' + port;
  const login = await waitFor(origin + '/login', response => response.status === 200);
  assert.match(login.headers.get('content-security-policy') ?? '', /frame-ancestors/);
  const user = await fetch(origin + '/api/user', { headers: { cookie: 'platform=valid' }, redirect: 'manual' });
  assert.equal(user.status, 200);
  assert.equal((await user.json()).login, 'bairui:test-user');
  assert.equal(user.headers.get('set-cookie'), null);
  const orgs = await fetch(origin + '/api/user/orgs', { headers: { cookie: 'platform=valid' } });
  assert.equal((await orgs.json())[0].role, 'Viewer');
  const adminLogin = await fetch(origin + '/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'compat-admin-secret' }), redirect: 'manual' });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers.get('set-cookie')?.match(/grafana_session=[^;,]+/)?.[0];
  assert.ok(adminCookie, 'grafana_admin_session_missing');
  const lookup = await fetch(origin + '/api/users/lookup?loginOrEmail=' + encodeURIComponent('bairui:test-user'), { headers: { cookie: adminCookie } });
  const technicalUser = await lookup.json();
  assert.ok(technicalUser.id);
  const promoted = await fetch(origin + '/api/org/users/' + technicalUser.id, { method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'Editor' }) });
  assert.equal(promoted.status, 200);
  const resynced = await fetch(origin + '/api/user/orgs', { headers: { cookie: 'platform=valid' } });
  assert.equal((await resynced.json())[0].role, 'Viewer');
  const forged = await fetch(origin + '/api/user', { headers: { 'x-bairui-monitor-user': 'bairui:forged' }, redirect: 'manual' });
  assert.equal(forged.status, 403);
  const fakeSession = await fetch(origin + '/api/user', { headers: { cookie: 'grafana_session=invalid' }, redirect: 'manual' });
  assert.notEqual(fakeSession.status, 200);
  await docker(['stop', names.auth]);
  const emergencyPage = await fetch(origin + '/login');
  assert.equal(emergencyPage.status, 200);
  const emergencyHtml = await emergencyPage.text();
  const assets = [...emergencyHtml.matchAll(/(?:src|href)="([^"#?]+)"/g)].map(match => new URL(match[1], origin + '/login').pathname).filter(path => path.startsWith('/public/'));
  assert.ok(assets.length > 0, 'grafana_login_assets_missing');
  for (const asset of assets) assert.equal((await fetch(origin + asset)).status, 200, asset);
  const emergencyLogin = await fetch(origin + '/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: 'compat-admin-secret' }), redirect: 'manual' });
  assert.equal(emergencyLogin.status, 200);
  const emergencyCookie = emergencyLogin.headers.get('set-cookie')?.match(/grafana_session=[^;,]+/)?.[0];
  assert.ok(emergencyCookie, 'emergency_grafana_session_missing');
  const emergencyUser = await fetch(origin + '/api/user', { headers: { cookie: emergencyCookie } });
  assert.equal(emergencyUser.status, 200);
  assert.equal((await emergencyUser.json()).login, 'admin');
  const unavailable = await fetch(origin + '/api/user', { headers: { cookie: 'platform=valid' }, redirect: 'manual' });
  assert.ok([502, 503].includes(unavailable.status));
  console.log('Grafana/Caddy compatibility: PASS (platform Viewer, forged identity rejected, emergency login independent)');
} catch (error) {
  for (const name of [names.auth, names.caddy, names.grafana]) {
    const status = await docker(['inspect', '-f', '{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}', name]).catch(inspectError => inspectError.message);
    const logs = await docker(['logs', '--tail', '80', name]).catch(logError => logError.message);
    console.error('\n[' + name + '] ' + status + '\n' + logs);
  }
  throw error;
} finally {
  for (const name of [names.grafana, names.caddy, names.auth]) await docker(['rm', '-f', name]).catch(() => {});
  await docker(['network', 'rm', names.network]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
