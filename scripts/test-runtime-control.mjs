import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { waitForPostgres } from './postgres-ready.mjs';

// Own disposable container only; never load the project's .env.
const exec = promisify(execFile);
const { Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const name = 'bairui-runtime-test-' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
const env = { ...process.env, POSTGRES_PASSWORD: password };
for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$)/.test(key)) delete env[key];
let created = false;
try {
  await exec('docker', ['run', '--rm', '-d', '--name', name, '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=runtime_check', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.2-pg17-bookworm'], { env, timeout: 120000, windowsHide: true });
  created = true;
  const { stdout } = await exec('docker', ['inspect', name], { windowsHide: true });
  const port = JSON.parse(stdout)[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  env.BAIRUI_RUNTIME_CONTROL_TEST_DATABASE_URL = `postgresql://postgres:${password}@127.0.0.1:${port}/runtime_check`;
  delete env.POSTGRES_PASSWORD;
  await waitForPostgres(() => new Client({ connectionString: env.BAIRUI_RUNTIME_CONTROL_TEST_DATABASE_URL, connectionTimeoutMillis: 2000, query_timeout: 2000 }));
  console.log('Runtime 一次性测试数据库已就绪。');
  const tests = [
    'runtime-control-contract.test.mjs', 'runtime-control-envelope.test.mjs',
    'runtime-control-memory.test.mjs', 'runtime-driver.test.mjs',
    'runtime-controller.test.mjs', 'runtime-control-postgres.test.mjs',
  ].map(file => 'apps/platform-api/test/' + file);
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...tests], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} catch (error) {
  console.error('Runtime 独立数据库验收失败：', error.code ?? error.name);
  process.exitCode = 1;
} finally {
  if (created) {
    try { await exec('docker', ['rm', '-f', name], { windowsHide: true, timeout: 30000 }); console.log('Runtime 一次性测试数据库已清理。'); }
    catch { console.error('本次测试容器清理失败：' + name); process.exitCode = 1; }
  }
}
