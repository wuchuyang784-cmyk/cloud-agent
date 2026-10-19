import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { waitForPostgres } from './postgres-ready.mjs';
const exec = promisify(execFile), { Client } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
const owner = randomBytes(12).toString('hex'), name = 'bairui-model-test-' + owner, label = 'bairui.test.model-access';
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|PG)/.test(key)) delete env[key];
env.POSTGRES_PASSWORD = randomBytes(24).toString('hex');
const docker = args => exec('docker', args, { env, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
let id;
try {
  const endpoint = JSON.parse((await docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])).stdout.trim());
  const effective = env.DOCKER_CONTEXT ? endpoint : env.DOCKER_HOST ?? endpoint;
  if (!/^(?:unix:\/\/\/|npipe:\/\/\/\/\.\/pipe\/)/.test(effective)) throw new Error('local_docker_required');
  await docker(['image', 'inspect', 'pgvector/pgvector:0.8.2-pg17-bookworm']);
  id = (await docker(['run', '--rm', '-d', '--pull=never', '--name', name, '--label', label + '=' + owner,
    '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=model_access_test', '-p', '127.0.0.1::5432', 'pgvector/pgvector:0.8.2-pg17-bookworm'])).stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('test_container_identity_invalid');
  const item = JSON.parse((await docker(['inspect', id])).stdout)[0];
  if (item.Config.Labels[label] !== owner) throw new Error('test_container_owner_invalid');
  const port = item.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  env.BAIRUI_MODEL_ACCESS_TEST_DATABASE_URL = `postgresql://postgres:${env.POSTGRES_PASSWORD}@127.0.0.1:${port}/model_access_test`;
  delete env.POSTGRES_PASSWORD;
  await waitForPostgres(() => new Client({ connectionString: env.BAIRUI_MODEL_ACCESS_TEST_DATABASE_URL, connectionTimeoutMillis: 2000, query_timeout: 2000 }));
  console.log('F2 一次性数据库就绪；未读取业务配置。');
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'apps/platform-api/test/model-access-postgres.test.mjs', 'apps/platform-api/test/model-access-live.test.mjs'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
} catch (error) { console.error('F2 数据库验收失败：' + (error.code ?? error.name)); process.exitCode = 1; }
finally {
  if (id && /^[a-f0-9]{64}$/.test(id)) {
    const item = JSON.parse((await docker(['inspect', id])).stdout)[0];
    if (item.Config.Labels[label] !== owner || item.Id !== id) throw new Error('test_cleanup_owner_invalid');
    await docker(['rm', '-f', id]); console.log('F2 临时数据库已清理。');
  }
}
