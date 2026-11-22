import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { waitForPostgres } from './postgres-ready.mjs';

const exec = promisify(execFile);
const { Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const root = fileURLToPath(new URL('../', import.meta.url));
const useBrowser = process.argv.slice(2).includes('--browser');
const browserModule = process.env.BAIRUI_PLAYWRIGHT_MODULE;
const browserExecutable = process.env.BAIRUI_BROWSER_EXECUTABLE;
const pgBin = process.env.BAIRUI_AUTH_EMAIL_TEST_PG_BIN;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|PG|NODE_OPTIONS$|DOCKER_CONTEXT$|DOCKER_HOST$)/i.test(key)));
const database = 'auth_email_test_' + randomBytes(12).toString('hex');
const password = randomBytes(24).toString('hex');
const connect = (port, db = database) => `postgresql://postgres:${password}@127.0.0.1:${port}/${db}`;
const ready = connectionString => waitForPostgres(() => new Client({ connectionString, connectionTimeoutMillis: 2000, query_timeout: 2000 }));
const run = (command, args, extra = {}) => exec(command, args, { env, windowsHide: true, timeout: 30000, ...extra });

let cleanup = async () => {};

async function dockerPostgres() {
  const { stdout: activeContext } = await run('docker', ['context', 'show']);
  const docker = (args, extra) => run('docker', ['--context', activeContext.trim(), ...args], extra);
  const { stdout: host } = await docker(['context', 'inspect', activeContext.trim(), '--format', '{{.Endpoints.docker.Host}}']);
  if (!/^(npipe|unix):\/\//.test(host.trim())) throw new Error('auth_email_fixture_requires_local_docker');
  const name = 'bairui-auth-email-' + database.slice('auth_email_test_'.length);
  const label = 'io.bairui.fixture.auth-email=' + database;
  let containerId;
  cleanup = async () => {
    // Discover by the random owner label if Docker created the container before reporting failure.
    const { stdout } = await docker(['ps', '-a', '--no-trunc', '--filter', 'label=' + label, '--format', '{{.ID}}']);
    const owned = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (owned.length === 0) return;
    if (owned.length !== 1 || !/^[a-f0-9]{64}$/.test(owned[0]) || (containerId && owned[0] !== containerId)) {
      throw new Error('auth_email_fixture_container_ownership_mismatch');
    }
    await docker(['rm', '-f', owned[0]]);
  };
  // Check the local engine before installing a cleanup step that requires it.
  try { await docker(['info', '--format', '{{.ServerVersion}}']); }
  catch (error) { cleanup = async () => {}; throw error; }
  const { stdout } = await docker(['run', '--rm', '-d', '--name', name, '--label', label,
    '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=' + database, '-p', '127.0.0.1::5432',
    'pgvector/pgvector:0.8.2-pg17-bookworm'], { env: { ...env, POSTGRES_PASSWORD: password }, timeout: 120000 });
  containerId = stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('auth_email_fixture_invalid_container_id');
  const inspected = await docker(['inspect', containerId]);
  const [binding] = JSON.parse(inspected.stdout)[0].NetworkSettings.Ports['5432/tcp'];
  if (binding.HostIp !== '127.0.0.1' || !/^\d+$/.test(binding.HostPort)) throw new Error('auth_email_fixture_requires_loopback');
  return connect(binding.HostPort);
}

async function freePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function nativePostgres() {
  if (!isAbsolute(pgBin)) throw new Error('BAIRUI_AUTH_EMAIL_TEST_PG_BIN must be an absolute PostgreSQL bin directory');
  const bin = name => join(pgBin, name + (process.platform === 'win32' ? '.exe' : ''));
  const temporary = await mkdtemp(join(tmpdir(), 'bairui-auth-email-'));
  const data = join(temporary, 'data');
  let startAttempted = false;
  cleanup = async () => {
    if (startAttempted) {
      const { code } = await run(bin('pg_ctl'), ['status', '-D', data]).then(() => ({ code: 0 }), error => error);
      if (code === 0) await run(bin('pg_ctl'), ['stop', '-w', '-m', 'fast', '-D', data]);
      else if (code !== 3) throw new Error('auth_email_fixture_server_status_unknown');
    }
    if (dirname(resolve(temporary)) !== resolve(tmpdir())) throw new Error('auth_email_fixture_temp_ownership_mismatch');
    await rm(temporary, { recursive: true, force: true });
  };
  const passwordFile = join(temporary, 'password');
  await writeFile(passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
  await run(bin('initdb'), ['-D', data, '-U', 'postgres', '-A', 'scram-sha-256', '--no-locale', '-E', 'UTF8', '--pwfile', passwordFile], { timeout: 90000 });
  await rm(passwordFile);
  const port = await freePort();
  startAttempted = true;
  await run(bin('pg_ctl'), ['start', '-w', '-D', data, '-l', join(temporary, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`]);
  const connectionString = connect(port, 'postgres');
  await ready(connectionString);
  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query('CREATE DATABASE ' + database);
  } finally { await client.end(); }
  return connect(port);
}

try {
  if (useBrowser && !browserModule) throw new Error('Set BAIRUI_PLAYWRIGHT_MODULE to an installed Playwright entrypoint.');
  const connectionString = await (pgBin ? nativePostgres() : dockerPostgres());
  await ready(connectionString);
  const testEnv = { ...env, BAIRUI_AUTH_EMAIL_TEST_DATABASE_URL: connectionString };
  if (useBrowser) {
    testEnv.BAIRUI_PLAYWRIGHT_MODULE = browserModule;
    if (browserExecutable) testEnv.BAIRUI_BROWSER_EXECUTABLE = browserExecutable;
  }
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'apps/platform-api/test/auth-email-postgres.test.mjs'], {
      cwd: root, env: testEnv, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} catch (error) {
  console.error('邮件认证数据库验收未完成。', error.stderr?.trim() || error.code || error.message);
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch (error) {
    console.error('邮件认证临时数据库清理失败。', database, error.code ?? error.message);
    process.exitCode = 1;
  }
}
