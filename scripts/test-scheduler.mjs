import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { waitForPostgres } from './postgres-ready.mjs';
import { fileURLToPath } from 'node:url';

// This runner never loads .env and creates its own disposable database container.
const exec = promisify(execFile);
const { Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const adminCheck = process.argv.includes('--admin');
const clientMonitoringCheck = process.argv.includes('--client-monitoring');
const platformCheck = process.argv.includes('--platform') || adminCheck || clientMonitoringCheck;
const name = (platformCheck ? 'bairui-platform-test-' : 'bairui-scheduler-test-') + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
const env = { ...process.env, POSTGRES_PASSWORD: password };
for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$)/.test(key)) delete env[key];
let created = false;
try {
  await exec('docker', ['run', '--rm', '-d', '--name', name, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=scheduler_check', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.2-pg17-bookworm'], { env, timeout: 120000 });
  created = true;
  const { stdout } = await exec('docker', ['inspect', name]);
  const port = JSON.parse(stdout)[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  env.BAIRUI_SCHEDULER_TEST_DATABASE_URL = 'postgresql://postgres:' + password + '@127.0.0.1:' + port + '/scheduler_check';
  if (platformCheck) env.BAIRUI_TEST_DATABASE_URL = env.BAIRUI_SCHEDULER_TEST_DATABASE_URL;
  delete env.POSTGRES_PASSWORD;
  await waitForPostgres(() => new Client({
    connectionString: env.BAIRUI_SCHEDULER_TEST_DATABASE_URL,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
  }));
  console.log('一次性测试数据库已就绪；不会连接项目 .env 中的数据库。');
  const code = await new Promise((resolve, reject) => {
    const tests = clientMonitoringCheck ? ['apps/platform-api/test/client-monitoring.test.mjs', 'apps/platform-api/test/client-monitoring-postgres.test.mjs'] : adminCheck ? ['apps/platform-api/test/admin.test.mjs', 'apps/platform-api/test/admin-postgres.test.mjs'] : platformCheck
      ? ['scripts/dev-services.test.mjs', 'scripts/setup-env.test.mjs', 'apps/platform-api/test/platform-mode.test.mjs', 'apps/platform-api/test/auth-proxy.test.mjs', 'apps/platform-api/test/auth-database.test.mjs', 'apps/platform-api/test/better-auth-postgres.test.mjs']
      : ['scripts/postgres-ready.test.mjs', 'apps/platform-api/test/scheduler.test.mjs', 'apps/platform-api/test/scheduler-api.test.mjs', 'apps/platform-api/test/scheduler-postgres.test.mjs'];
    const child = spawn(process.execPath, ['--test', ...tests], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  process.exitCode = code;
} catch (e) {
  console.error('独立数据库验收未完成：', e.code ?? e.name);
  process.exitCode = 1;
} finally {
  if (created) {
    try { await exec('docker', ['rm', '-f', name]); console.log('一次性测试数据库已清理。'); }
    catch { console.error('请检查并清理本次测试容器：' + name); process.exitCode = 1; }
  }
}
