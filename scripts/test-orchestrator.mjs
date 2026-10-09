import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForPostgres } from './postgres-ready.mjs';

const exec = promisify(execFile);
const { Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const installationId = `br-e2-test-${randomBytes(6).toString('hex')}`;
const network = `${installationId}-net`; const database = `${installationId}-db`;
const owner = 'io.bairui.orchestrator.installation';
const password = randomBytes(24).toString('hex'); const appPassword = randomBytes(24).toString('hex');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|POSTGRES_)/.test(key)) delete env[key];
const cli = async args => (await exec('docker', args, { env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim();
let attemptedResources = false; let networkConfirmed = false; let databaseConfirmed = false; let certificateDirectory;
try {
  certificateDirectory = await mkdtemp(join(tmpdir(), 'bairui-e2-cert-'));
  const certFile = join(certificateDirectory, 'cert.pem'); const keyFile = join(certificateDirectory, 'key.pem');
  try {
    await exec('openssl', ['req', '-config', fileURLToPath(new URL('../apps/platform-api/test/helpers/orchestrator-tls.cnf', import.meta.url)),
      '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { env, windowsHide: true, timeout: 15000 });
  } catch (error) { console.error(String(error.stderr ?? '').slice(0, 2048)); throw error; }
  env.BAIRUI_ORCHESTRATOR_TEST_CERT_FILE = certFile; env.BAIRUI_ORCHESTRATOR_TEST_KEY_FILE = keyFile;
  // Resolve installed image once; no pull, tag mutation, business config or shared volume.
  const image = JSON.parse(await cli(['image', 'inspect', 'node:22-alpine']))[0].Id;
  const databaseImage = JSON.parse(await cli(['image', 'inspect', 'pgvector/pgvector:0.8.2-pg17-bookworm']))[0].Id;
  attemptedResources = true;
  await cli(['network', 'create', '--internal', '--label', `${owner}=${installationId}`, network]); networkConfirmed = true;
  env.POSTGRES_PASSWORD = password;
  await cli(['run', '--pull=never', '-d', '--name', database, '--label', `${owner}=${installationId}`, '--env', 'POSTGRES_PASSWORD',
    '--env', 'POSTGRES_DB=orchestrator_check', '-p', '127.0.0.1::5432', databaseImage]);
  databaseConfirmed = true;
  delete env.POSTGRES_PASSWORD;
  const port = JSON.parse(await cli(['inspect', database]))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/orchestrator_check`;
  await waitForPostgres(() => new Client({ connectionString: adminUrl, connectionTimeoutMillis: 2000, query_timeout: 2000 }));
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(await readFile(new URL('../apps/platform-api/src/runtime/orchestrator/schema.sql', import.meta.url), 'utf8'));
    await admin.query('INSERT INTO bairui_orchestrator.installation(installation_id) VALUES($1)', [installationId]);
    await admin.query(`CREATE ROLE orchestrator_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA bairui_orchestrator TO orchestrator_app;
      GRANT SELECT ON bairui_orchestrator.installation TO orchestrator_app;
      GRANT SELECT,INSERT,UPDATE ON bairui_orchestrator.runs TO orchestrator_app;
      GRANT SELECT,INSERT,DELETE ON bairui_orchestrator.nonces TO orchestrator_app;`);
  } finally { await admin.end(); }
  Object.assign(env, { BAIRUI_ORCHESTRATOR_TEST_DATABASE_URL: `postgresql://orchestrator_app:${appPassword}@127.0.0.1:${port}/orchestrator_check`,
    BAIRUI_ORCHESTRATOR_TEST_INSTALLATION: installationId, BAIRUI_ORCHESTRATOR_TEST_NETWORK: network, BAIRUI_ORCHESTRATOR_TEST_IMAGE: image });
  console.log('E2 独立受限数据库、内部网络已就绪；使用真实 Docker 容器验收。');
  const files = ['orchestrator.test.mjs', 'orchestrator-docker.test.mjs', 'orchestrator-http.test.mjs', 'orchestrator-config.test.mjs', 'orchestrator-integration.test.mjs'];
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files.map(file => `apps/platform-api/test/${file}`)],
      { env, cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
} catch (error) { console.error('E2 隔离验收失败：', error.code ?? error.name); process.exitCode = 1; }
finally {
  try {
    // Resolve exact IDs, then independently verify labels before each removal.
    if (attemptedResources) {
      const ids = (await cli(['ps', '-a', '--no-trunc', '--filter', `label=${owner}=${installationId}`, '--format', '{{.ID}}'])).split(/\s+/).filter(Boolean);
      for (const id of ids) {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('cleanup_id_invalid');
        const info = JSON.parse(await cli(['inspect', id]))[0];
        if (info.Id !== id || info.Config.Labels?.[owner] !== installationId) throw new Error('cleanup_owner_invalid');
        await cli(['rm', '-f', '-v', id]);
      }
      const networkIds = (await cli(['network', 'ls', '--no-trunc', '--filter', `label=${owner}=${installationId}`, '--format', '{{.ID}}'])).split(/\s+/).filter(Boolean);
      for (const id of networkIds) {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('cleanup_id_invalid');
        const info = JSON.parse(await cli(['network', 'inspect', id]))[0];
        if (info.Id !== id || info.Name !== network || info.Labels?.[owner] !== installationId) throw new Error('cleanup_owner_invalid');
        await cli(['network', 'rm', id]);
      }
      if (!networkConfirmed || !databaseConfirmed) {
        console.error('E2 资源创建未全部确认，已清理当前可见资源；迟到资源需按安装标识复核：' + installationId);
        process.exitCode = 1;
      } else console.log('E2 本次可见测试容器、临时数据库卷与内部网络已精确清理。');
    }
  } catch { console.error('E2 测试资源清理失败，安装标识：' + installationId); process.exitCode = 1; }
  if (certificateDirectory) {
    if (dirname(resolve(certificateDirectory)) !== resolve(tmpdir()) || !basename(certificateDirectory).startsWith('bairui-e2-cert-')) {
      console.error('E2 临时证书路径校验失败'); process.exitCode = 1;
    } else await rm(certificateDirectory, { recursive: true, force: true });
  }
}
