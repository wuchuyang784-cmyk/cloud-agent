import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeNames, runtimeContainerArguments, controllerGrants } from './runtime-deployment-config.mjs';
import { readFile } from 'node:fs/promises';

const input = { environment: 'preprod', installation: 'a'.repeat(24), directory: 'E:/cloud-agent/output/runtime/preprod',
  apiImage: 'bairui/platform-api-preprod:' + 'b'.repeat(16), orchestratorImage: 'bairui/runtime-orchestrator:' + 'c'.repeat(16) };
test('managed deployment separates environments and pins private restartable containers', () => {
  assert.notEqual(runtimeNames('business').controller, runtimeNames('preprod').controller);
  for (const kind of ['controller', 'orchestrator']) {
    const args = runtimeContainerArguments(kind, input);
    assert.ok(args.includes('--restart=unless-stopped'));
    assert.ok(args.includes('--init'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--security-opt=no-new-privileges:true'));
    assert.ok(args.includes('--cap-drop=ALL'));
    assert.ok(!args.some(a => /^(--publish|-p|--privileged|--env-file)/.test(a)));
    assert.ok(!args.join(' ').includes('PASSWORD'));
    assert.ok(!args.join(' ').includes('DATABASE_URL'));
    assert.ok(args.includes(kind));
    assert.ok(args.includes('--label'));
    const socket = args.join(' ').includes('/var/run/docker.sock');
    assert.equal(socket, kind === 'orchestrator');
    assert.ok(args.includes(kind === 'controller' ? '--user=1000:1000' : '--user=0:0'));
  }
});
test('managed grants do not grant user control, tables or credential access', () => {
  const sql = controllerGrants();
  assert.ok(sql.includes('runtime_supervision_snapshot()'));
  assert.equal((sql.match(/runtime_control_|runtime_supervision_/g) ?? []).length, 9);
  assert.ok(!sql.match(/request_start|request_stop|ALL TABLES|BYPASSRLS|ba_session/));
});
test('deployment asset inputs reject ambiguous targets and path escapes', () => {
  assert.throws(() => runtimeNames('prod'));
  assert.throws(() => runtimeContainerArguments('api', input));
  assert.throws(() => runtimeContainerArguments('controller', { ...input, installation: 'invalid' }));
  assert.throws(() => runtimeContainerArguments('controller', { ...input, apiImage: 'node:latest' }));
});
test('rollout grants database CONNECT and checks installed runtime before preprod mutations', async () => {
  const deployment = await readFile(new URL('./runtime-deployment.mjs', import.meta.url), 'utf8');
  assert.match(deployment, /GRANT CONNECT ON DATABASE \$\{n\.database\} TO bairui_runtime_controller/);
  const preprod = await readFile(new URL('./preprod.mjs', import.meta.url), 'utf8');
  assert.ok(preprod.indexOf("assertRuntimeResources('preprod', state)") < preprod.indexOf('const rev = await revision(state)'));
  assert.ok(preprod.indexOf("stopRuntimeEnvironment('preprod')") < preprod.indexOf("'数据库停止'"));
});
