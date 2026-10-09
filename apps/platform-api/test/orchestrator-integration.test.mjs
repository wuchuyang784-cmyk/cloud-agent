import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { DockerOrchestratorDriver, containerName } from '../src/runtime/orchestrator/docker.mjs';
import { PostgresOrchestratorLedger } from '../src/runtime/orchestrator/ledger.mjs';
import { Orchestrator } from '../src/runtime/orchestrator/service.mjs';
import { createOrchestratorServer } from '../src/runtime/orchestrator/http.mjs';
import { RemoteRuntimeDriver } from '../src/runtime/orchestration/remote-driver.mjs';
import { signControlRequest, verifyControlResponse } from '../src/runtime/control-envelope.mjs';
import { unusedLoopbackPort, launchOrchestrator, killOrchestrator, signedHttps } from './helpers/orchestrator-process.mjs';

const connectionString = process.env.BAIRUI_ORCHESTRATOR_TEST_DATABASE_URL;
const exec = promisify(execFile);
test('E2 real restricted PostgreSQL + Docker acceptance', { skip: !connectionString, timeout: 240000 }, async t => {
  const installationId = process.env.BAIRUI_ORCHESTRATOR_TEST_INSTALLATION;
  const network = process.env.BAIRUI_ORCHESTRATOR_TEST_NETWORK;
  const image = process.env.BAIRUI_ORCHESTRATOR_TEST_IMAGE;
  const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 2000, statement_timeout: 3000 });
  t.after(() => pool.end());
  const ledger = new PostgresOrchestratorLedger({ pool, installationId });
  const docker = new DockerOrchestratorDriver({ installationId, network, image });
  let now = Date.now();
  let service = new Orchestrator({ ledger, docker, clock: () => now });
  const spec = { agentId: randomUUID(), runId: randomUUID(), runGeneration: 1, engine: 'pi',
    resourceSpec: { cpuMillis: 200, memoryBytes: 134217728, pidsLimit: 32, idleTtlSeconds: 60 } };
  const stop = { ...spec, fenceGeneration: 2, reason: 'isolated acceptance' };
  const secret = randomBytes(32).toString('hex');
  let server;
  const listen = async () => {
    server = createOrchestratorServer({ service, nonceStore: ledger, keys: { primary: secret }, allowTestHttp: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let origin = await listen();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const remote = () => new RemoteRuntimeDriver({ env: { NODE_ENV: 'test' }, allowInsecureHttp: true,
    orchestratorUrl: origin, orchestratorKeyId: 'primary', orchestratorSecret: secret,
    allowedRuntimeHosts: [containerName(installationId, spec.runId)], requestTimeoutMs: 25000 });
  const cli = async args => (await exec('docker', args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
  let runtime;

  await t.test('dedicated restricted ledger and network/image prerequisites', async () => {
    await ledger.check(); await docker.check();
    await assert.rejects(new PostgresOrchestratorLedger({ pool, installationId: 'wrong-install' }).check(), /installation_mismatch/);
    assert.equal((await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper, false);
    await assert.rejects(pool.query('DELETE FROM bairui_orchestrator.runs'));
    await assert.rejects(pool.query("UPDATE bairui_orchestrator.installation SET installation_id='wrong-install'"));
  });

  await t.test('signed E1 driver launches actual probe with kernel cgroup and filesystem isolation', async () => {
    try { runtime = await remote().provision({ ...spec, requestId: randomUUID() }); }
    catch (error) { t.diagnostic(`launch phase: ${(await ledger.read(spec.runId))?.phase}`); throw error; }
    assert.equal(runtime.status, 'running');
    const info = JSON.parse(await cli(['inspect', runtime.orchestratorRef]))[0];
    assert.equal(info.HostConfig.NanoCpus, 200000000);
    assert.equal(info.HostConfig.Memory, 134217728);
    assert.equal(info.HostConfig.PidsLimit, 32);
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.equal(info.Config.User, '1000:1000');
    assert.deepEqual(info.Mounts, []);
    assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0);
    const kernel = JSON.parse(await cli(['exec', runtime.orchestratorRef, 'node', '-e',
      "const fs=require('node:fs');let readonly=false;try{fs.writeFileSync('/tmp/e2-probe','x')}catch(e){readonly=e.code==='EROFS'};console.log(JSON.stringify({uid:process.getuid(),readonly,cpu:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()}))"]));
    assert.equal(kernel.uid, 1000); assert.equal(kernel.readonly, true);
    const [quota, period] = kernel.cpu.split(' ').map(Number);
    assert.equal(quota / period, 0.2);
    assert.equal(kernel.memory, '134217728'); assert.equal(kernel.pids, '32');
  });

  await t.test('persisted JSONB retry has same container; conflicting resource rejected', async () => {
    const retry = await remote().provision({ ...spec, requestId: randomUUID() });
    assert.equal(retry.orchestratorRef, runtime.orchestratorRef);
    await assert.rejects(service.start({ ...spec, resourceSpec: { ...spec.resourceSpec, cpuMillis: 300 } }), /spec_conflict/);
  });

  await t.test('real DELETE confirmation and durable tombstone/nonce after HTTP service recreation', async () => {
    const path = `/v1/runs/${spec.runId}`;
    const requestId = randomUUID();
    const headers = signControlRequest({ method: 'GET', path, requestId, keyId: 'primary', secret });
    const first = await fetch(origin + path, { headers });
    const body = await first.text();
    verifyControlResponse({ status: first.status, requestId, requestNonce: headers['x-bairui-control-nonce'], body, headers: first.headers, keys: { primary: secret } });
    const result = await remote().stop({ ...stop, requestId: randomUUID() });
    assert.equal(result.status, 'stopped');
    assert.equal(await cli(['ps', '-a', '--no-trunc', '--filter', `id=${runtime.orchestratorRef}`, '--format', '{{.ID}}']), '');
    await new Promise(resolve => server.close(resolve));
    service = new Orchestrator({ ledger: new PostgresOrchestratorLedger({ pool, installationId }), docker });
    origin = await listen();
    assert.equal((await fetch(origin + path, { headers })).status, 401);
    await assert.rejects(service.start(spec), /run_fenced/);
    assert.equal((await service.inspect(spec.runId)).status, 'stopped');
  });

  await t.test('absent stop persists forever and blocks late PUT through fresh ledger', async () => {
    const absent = { ...spec, runId: randomUUID() };
    assert.equal((await service.stop({ ...absent, fenceGeneration: 2, reason: 'stop before create' })).status, 'absent');
    const fresh = new Orchestrator({ ledger: new PostgresOrchestratorLedger({ pool, installationId }), docker });
    await assert.rejects(fresh.start(absent), /run_fenced/);
    assert.equal(await cli(['ps', '-a', '--filter', `name=^/${containerName(installationId, absent.runId)}$`, '--format', '{{.ID}}']), '');
  });

  await t.test('TTL reaper actually removes container; GET and start retry cannot extend expiry', async () => {
    service = new Orchestrator({ ledger, docker, clock: () => now });
    const idle = { ...spec, runId: randomUUID() };
    const started = await service.start(idle);
    await service.start(idle); await service.inspect(idle.runId);
    now += 61000;
    const result = await service.reap();
    assert.equal(result.failed, 0); assert.equal(result.reclaimed, 1);
    assert.equal(await cli(['ps', '-a', '--filter', `id=${started.orchestratorRef}`, '--format', '{{.ID}}']), '');
  });

  await t.test('two real pools serialize same run and share atomic nonce protection', async () => {
    const secondPool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 2000 });
    try {
      const second = new PostgresOrchestratorLedger({ pool: secondPool, installationId });
      await ledger.withRun('locked-run', async () => {
        await assert.rejects(second.withRun('locked-run', async () => {}), /run_busy/);
      });
      const nonce = randomUUID();
      const results = await Promise.all([ledger.consume('primary', nonce, Date.now() + 120000, Date.now()), second.consume('primary', nonce, Date.now() + 120000, Date.now())]);
      assert.deepEqual(results.sort(), [false, true]);
    } finally { await secondPool.end(); }
  });

  await t.test('renamed real container is removed by immutable ID, not mistaken for absent', async () => {
    const renamed = { ...spec, runId: randomUUID() };
    service = new Orchestrator({ ledger, docker });
    const started = await service.start(renamed);
    await cli(['rename', started.orchestratorRef, `${containerName(installationId, renamed.runId)}-renamed`]);
    assert.equal((await service.stop({ ...renamed, fenceGeneration: 2, reason: 'rename recovery' })).status, 'stopped');
    assert.equal(await cli(['ps', '-a', '--filter', `id=${started.orchestratorRef}`, '--format', '{{.ID}}']), '');
  });

  await t.test('database connection loss after real create is recovered without duplicate container', async () => {
    const applicationName = `e2_fault_${randomBytes(6).toString('hex')}`;
    const faultPool = new pg.Pool({ connectionString, max: 1, application_name: applicationName, connectionTimeoutMillis: 2000 });
    faultPool.on('error', () => {});
    try {
      const faultLedger = new PostgresOrchestratorLedger({ pool: faultPool, installationId });
      const crash = { ...spec, runId: randomUUID() }; let createdId;
      const faultDocker = Object.create(docker);
      faultDocker.create = async row => {
        const created = await docker.create(row); createdId = created.id;
        await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1', [applicationName]);
        await new Promise(resolve => setTimeout(resolve, 100));
        return created;
      };
      const crashed = new Orchestrator({ ledger: faultLedger, docker: faultDocker });
      await assert.rejects(crashed.start(crash));
      assert.equal((await ledger.read(crash.runId)).phase, 'creating');
      assert.equal((await ledger.read(crash.runId)).containerId, null);
      const recovered = await service.start(crash);
      assert.equal(recovered.orchestratorRef, createdId);
      assert.equal((await service.stop({ ...crash, fenceGeneration: 2, reason: 'after recovery' })).status, 'stopped');
    } finally { await faultPool.end(); }
  });

  await t.test('real deletion with lost result remains stopping until fresh inspection confirms', async () => {
    const lost = { ...spec, runId: randomUUID() };
    const started = await service.start(lost);
    const faultDocker = Object.create(docker);
    faultDocker.find = docker.find.bind(docker);
    faultDocker.remove = async row => { await docker.remove(row); throw new Error('result_lost'); };
    const faulty = new Orchestrator({ ledger, docker: faultDocker });
    await assert.rejects(faulty.stop({ ...lost, fenceGeneration: 2, reason: 'delete' }), /result_lost/);
    assert.equal((await ledger.read(lost.runId)).phase, 'stopping');
    assert.equal(await cli(['ps', '-a', '--filter', `id=${started.orchestratorRef}`, '--format', '{{.ID}}']), '');
    assert.equal((await service.inspect(lost.runId)).status, 'stopped');
  });

  await t.test('standalone TLS process crash/restart retains container, tombstone and nonce without disabling TLS validation', async () => {
    const port = await unusedLoopbackPort();
    const childEnv = { ...process.env, BAIRUI_ORCHESTRATOR_MODE: 'isolation', BAIRUI_ORCHESTRATOR_DATABASE_URL: connectionString,
      BAIRUI_ORCHESTRATOR_INSTALLATION: installationId, BAIRUI_ORCHESTRATOR_NETWORK: network, BAIRUI_ORCHESTRATOR_IMAGE: image,
      BAIRUI_RUNTIME_CONTROL_KEY_ID: 'primary', BAIRUI_RUNTIME_CONTROL_SECRET: secret, BAIRUI_ORCHESTRATOR_PORT: String(port),
      BAIRUI_ORCHESTRATOR_REAP_INTERVAL_MS: '60000', BAIRUI_ORCHESTRATOR_TLS_CERT_FILE: process.env.BAIRUI_ORCHESTRATOR_TEST_CERT_FILE,
      BAIRUI_ORCHESTRATOR_TLS_KEY_FILE: process.env.BAIRUI_ORCHESTRATOR_TEST_KEY_FILE };
    const childSpec = { ...spec, runId: randomUUID() };
    const path = `/v1/runs/${childSpec.runId}`;
    let child;
    const call = async (method, target, input, suppliedHeaders) => {
      const body = input ? JSON.stringify(input) : '';
      const headers = suppliedHeaders ?? signControlRequest({ method, path: target, body, requestId: randomUUID(), keyId: 'primary', secret });
      const response = await signedHttps(port, childEnv.BAIRUI_ORCHESTRATOR_TLS_CERT_FILE, method, target, headers, body);
      if (response.status !== 401) verifyControlResponse({ status: response.status, requestId: headers['x-bairui-control-request-id'],
        requestNonce: headers['x-bairui-control-nonce'], body: response.raw, headers: response.headers, keys: { primary: secret } });
      return { ...response, value: JSON.parse(response.raw), sentHeaders: headers };
    };
    try {
      child = await launchOrchestrator(childEnv);
      const start = await call('PUT', path, childSpec);
      assert.equal(start.status, 200);
      const observed = await call('GET', path);
      await killOrchestrator(child);
      child = await launchOrchestrator(childEnv);
      assert.equal((await call('GET', path, null, observed.sentHeaders)).status, 401);
      let recovered;
      for (let attempt = 0; attempt < 20; attempt++) {
        recovered = await call('GET', path);
        if (recovered.status !== 503 || recovered.value.error !== 'run_busy') break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.equal(recovered.status, 200, JSON.stringify(recovered.value));
      assert.equal(recovered.value.orchestratorRef, start.value.orchestratorRef);
      const stopped = await call('POST', path + '/stop', { agentId: childSpec.agentId, runId: childSpec.runId,
        runGeneration: 1, fenceGeneration: 2, reason: 'process restart test' });
      assert.equal(stopped.value.status, 'stopped');
      await killOrchestrator(child);
      child = await launchOrchestrator(childEnv);
      assert.equal((await call('PUT', path, childSpec)).status, 409);
      assert.equal(await cli(['ps', '-a', '--filter', `id=${start.value.orchestratorRef}`, '--format', '{{.ID}}']), '');
    } finally { await killOrchestrator(child); }
  });
});
