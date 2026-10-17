import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { waitForPostgres } from './postgres-ready.mjs';

// Only a fresh randomly named database. Never load .env or use a caller-supplied database URL.
const exec = promisify(execFile);
const { Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const name = 'bairui-announcements-test-' + randomBytes(8).toString('hex');
const password = randomBytes(24).toString('hex');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|PG)/.test(key)) delete env[key];
env.POSTGRES_PASSWORD = password;
let id;
try {
  const result = await exec('docker', ['run', '--rm', '-d', '--name', name, '--label', 'bairui.test=announcements', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=announcements_check', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.2-pg17-bookworm'], { env, timeout: 120000, windowsHide: true });
  id = result.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('invalid_test_container_id');
  const { stdout } = await exec('docker', ['inspect', id], { windowsHide: true });
  const port = JSON.parse(stdout)[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL = 'postgresql://postgres:' + password + '@127.0.0.1:' + port + '/announcements_check';
  delete env.POSTGRES_PASSWORD;
  await waitForPostgres(() => new Client({ connectionString: env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL, connectionTimeoutMillis: 2000, query_timeout: 2000 }));
  console.log('公告一次性数据库已就绪；不读取业务 .env。');
  const publisherTests = (await readdir(new URL('../apps/platform-api/test/', import.meta.url)))
    .filter(file => /^announcements?-publisher.*\.test\.mjs$/.test(file)).sort().map(file => 'apps/platform-api/test/' + file);
  const tests = process.argv.includes('--publisher') ? publisherTests : ['apps/platform-api/test/announcements.test.mjs', 'apps/platform-api/test/announcements-api.test.mjs', 'apps/platform-api/test/announcements-postgres.test.mjs', 'apps/platform-api/test/announcements-api-postgres.test.mjs', 'apps/platform-api/test/notification-center.test.mjs', 'apps/platform-api/test/notification-center-postgres.test.mjs', 'apps/platform-api/test/notification-center-api.test.mjs', ...publisherTests];
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
} catch (error) {
  console.error('公告独立数据库验收失败：' + (error.code ?? error.name)); process.exitCode = 1;
} finally {
  if (id && /^[0-9a-f]{64}$/.test(id)) {
    try { await exec('docker', ['rm', '-f', id], { timeout: 30000, windowsHide: true }); console.log('公告一次性数据库已清理。'); }
    catch { console.error('本次临时容器需检查：' + name); process.exitCode = 1; }
  }
}
