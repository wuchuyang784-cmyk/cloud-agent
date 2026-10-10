import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { PostgresRuntimeControlStore } from '../src/runtime/postgres-control-store.mjs';
import { DockerOrchestratorDriver, containerName } from '../src/runtime/orchestrator/docker.mjs';
import { PostgresOrchestratorLedger } from '../src/runtime/orchestrator/ledger.mjs';
import { Orchestrator } from '../src/runtime/orchestrator/service.mjs';
import { createOrchestratorServer } from '../src/runtime/orchestrator/http.mjs';
import { unusedLoopbackPort, killOrchestrator } from './helpers/orchestrator-process.mjs';
import { startRuntimeController } from '../src/runtime/supervision/index.mjs';

export async function supervisionDatabase(connectionString) {
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `supervision_${suffix}`, role = `supervisor_${suffix}`;
  const owner = new Pool({ connectionString });
  const admin = new Pool({ connectionString, options: `-c search_path=${schema},public` });
  let pool, other;
  const close = async () => {
    await Promise.all([pool?.end(), other?.end()]);
    await admin.end();
    await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP ROLE IF EXISTS ${role}`);
    await owner.end();
  };
  try {
    await owner.query(`CREATE SCHEMA ${schema}; CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    // Prove E3 has no dependency on simulation migrations 033/038.
    const root = new URL('../../../packages/db/migrations/', import.meta.url);
    const files = await readdir(root);
    for (const prefix of ['001', '022', '023', '024', '025', '026', '027', '028', '029', '030', '031', '032', '034', '036', '037', '039', '040']) {
      const file = files.find(file => file.startsWith(prefix + '_'));
      assert.ok(file, `missing migration ${prefix}`);
      await admin.query(await readFile(new URL(file, root), 'utf8'));
    }
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role};
      GRANT EXECUTE ON FUNCTION runtime_control_request_start(text,text,uuid,bigint,integer,bigint,integer,integer),
        runtime_control_request_stop(text,text,uuid,bigint,text), runtime_control_claim(text,integer),
        runtime_control_prepare(text,uuid,integer), runtime_control_complete(text,uuid,text,text,integer),
        runtime_control_commit_started(text,uuid,text,text,bigint,text,text,integer),
        runtime_control_commit_stopped(text,uuid,text,text,bigint,bigint,text,timestamptz,integer),
        runtime_control_reconcile_governance(text,integer), runtime_supervision_claim(text),
        runtime_supervision_record(text,uuid,text,text,bigint,bigint,text,timestamptz,text,text),
        runtime_supervision_snapshot() TO ${role};
      INSERT INTO organizations(id,name) VALUES('org','E3');
      INSERT INTO users(id,email) VALUES('u','e3@example.test');
      INSERT INTO agents(id,organization_id,owner_user_id,name,status,runtime_kind,engine,template_version,host)
        VALUES('a','org','u','E3','stopped','pi','pi',1,'e3.example.test');`);
    const options = { connectionString, options: `-c search_path=${schema},public -c role=${role}`, max: 2, connectionTimeoutMillis: 2000 };
    pool = new Pool(options); other = new Pool(options);
    return { admin, pool, other, schema, role, store: new PostgresRuntimeControlStore({ pool }),
      second: new PostgresRuntimeControlStore({ pool: other }), close };
  } catch (error) { await close(); throw error; }
}

export const resources = { cpuMillis: 200, memoryBytes: 134217728, pidsLimit: 32, idleTtlSeconds: 60 };
export async function runningFixture(db) {
  const start = await db.store.requestStart({ actorUserId: 'u', agentId: 'a', requestId: randomUUID(), expectedGeneration: 0, resourceSpec: resources });
  const [command] = await db.store.claimCommands('worker', 1);
  await db.store.commitStarted({ ...command.payload, workerId: 'worker', requestId: command.requestId, leaseAttempt: command.attempts,
    orchestratorRef: 'container', runtimeUrl: 'http://probe:8092' });
  await db.store.completeCommand({ workerId: 'worker', commandId: command.id, leaseAttempt: command.attempts, status: 'succeeded' });
  return start;
}
const receipt = (claim, status = 'running') => ({ ...claim, status, observedAt: new Date().toISOString(),
  orchestratorRef: 'container', runtimeUrl: 'http://probe:8092' });

test('Postgres supervision wrapper checks out bounded transaction and rolls rejected receipts back', async () => {
  const calls = [];
  const store = new PostgresRuntimeControlStore({ pool: { connect: async () => ({ query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: sql.startsWith('SELECT runtime_supervision_record') ? [{ result: { error: 'observation_lease_lost' } }] : [] };
  }, release() {} }) } });
  await assert.rejects(store.recordObservation(receipt({ workerId: 'w', leaseToken: randomUUID(), agentId: 'a', runId: 'r', runGeneration: 1, controlGeneration: 1 })), /observation_lease_lost/);
  assert.equal(calls[0].sql, 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.ok(calls.some(call => call.sql.includes('lock_timeout')));
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('Postgres supervision: two pools, fenced observation, diagnostics, governance and privileges', {
  skip: !process.env.BAIRUI_RUNTIME_CONTROL_TEST_DATABASE_URL,
}, async t => {
  const db = await supervisionDatabase(process.env.BAIRUI_RUNTIME_CONTROL_TEST_DATABASE_URL);
  try {
    const start = await runningFixture(db);
    let lease;
    await t.test('two pools have one lease; restart reclaims with fresh random token', async () => {
      const claims = await Promise.all([db.store.claimObservation('same'), db.second.claimObservation('same')]);
      assert.equal(claims.filter(Boolean).length, 1); lease = claims.find(Boolean);
      await db.admin.query("UPDATE agent_runtime_controls SET observation_until=now()-interval '1s'");
      const next = await db.second.claimObservation('same');
      assert.notEqual(next.leaseToken, lease.leaseToken);
      await assert.rejects(db.store.recordObservation(receipt(lease, 'absent')), /observation_lease_lost/);
      lease = next;
    });
    await t.test('identity conflict rolls back; error preserves allocation and old success; missing route cannot be recreated', async () => {
      await assert.rejects(db.store.recordObservation({ ...receipt(lease), runtimeUrl: 'http://other:8092' }), /observation_identity_conflict/);
      await db.store.recordObservation(receipt(lease, 'error'));
      assert.equal((await db.store.supervisionSnapshot()).active, 1);
      assert.equal((await db.store.supervisionSnapshot()).observationErrors, 1);
      await db.admin.query("UPDATE agent_runtime_controls SET observation_next_at=now()-interval '1s'; DELETE FROM runtime_routes");
      lease = await db.store.claimObservation('observer');
      await db.store.recordObservation(receipt(lease));
      assert.equal((await db.store.supervisionSnapshot()).observationErrors, 0);
      assert.equal((await db.admin.query('SELECT * FROM runtime_routes')).rowCount, 0);
    });
    await t.test('observation waits for governance lock and retains shared lock until commit', async () => {
      await db.admin.query("UPDATE agent_runtime_controls SET observation_next_at=now()-interval '1s'");
      const claim = await db.store.claimObservation('observer');
      const governor = await db.admin.connect(), observer = await db.pool.connect();
      const observingStore = new PostgresRuntimeControlStore({ pool: { connect: async () => ({ query: observer.query.bind(observer), release() {} }) } });
      let pending;
      const blocked = async (waiter, blocker) => {
        for (let index = 0; index < 100; index++) {
          if ((await db.admin.query('SELECT $2::integer=ANY(pg_blocking_pids($1)) blocked', [waiter, blocker])).rows[0].blocked) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail('governance lock was bypassed');
      };
      try {
        const governorPid = (await governor.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const observerPid = (await observer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await governor.query('BEGIN');
        await governor.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${db.schema}:governance:changes`]);
        pending = observingStore.recordObservation(receipt(claim)); pending.catch(() => {});
        await blocked(observerPid, governorPid);
        await governor.query('COMMIT'); await pending;
        await db.admin.query("UPDATE agent_runtime_controls SET observation_next_at=now()-interval '1s'");
        const next = await db.store.claimObservation('observer');
        await observer.query('BEGIN');
        await observer.query('SELECT runtime_supervision_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [next.workerId, next.leaseToken, next.agentId, next.runId, next.runGeneration, next.controlGeneration,
            'running', new Date().toISOString(), 'container', 'http://probe:8092']);
        await governor.query('BEGIN');
        pending = governor.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${db.schema}:governance:changes`]); pending.catch(() => {});
        await blocked(governorPid, observerPid);
        await observer.query('COMMIT'); await pending; await governor.query('COMMIT');
      } finally {
        await observer.query('ROLLBACK'); await governor.query('ROLLBACK'); await pending?.catch(() => {});
        observer.release(); governor.release();
      }
    });
    await t.test('a failure after control mutation rolls terminal update and audit back', async () => {
      await db.admin.query("UPDATE agent_runtime_controls SET observation_next_at=now()-interval '1s'");
      const claim = await db.store.claimObservation('observer');
      await db.admin.query(`CREATE FUNCTION fail_e3_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test_fault'; END $$;
        CREATE TRIGGER fail_e3_terminal BEFORE UPDATE ON agent_engine_runs FOR EACH ROW EXECUTE FUNCTION fail_e3_terminal()`);
      try {
        await assert.rejects(db.store.recordObservation(receipt(claim, 'stopped')), /runtime_control_unavailable/);
        assert.equal((await db.admin.query('SELECT active_run_id,observation_token FROM agent_runtime_controls')).rows[0].active_run_id, claim.runId);
        assert.equal((await db.admin.query('SELECT observation_token FROM agent_runtime_controls')).rows[0].observation_token, claim.leaseToken);
        assert.equal((await db.admin.query("SELECT * FROM agent_runtime_control_requests WHERE reason='observed_terminal'")).rowCount, 0);
      } finally { await db.admin.query('DROP TRIGGER fail_e3_terminal ON agent_engine_runs; DROP FUNCTION fail_e3_terminal()'); }
      await db.store.recordObservation(receipt(claim));
    });
    await t.test('governance changes invalidate observation and terminal receipt resolves active dead command', async () => {
      await db.admin.query("UPDATE agent_runtime_controls SET observation_next_at=now()-interval '1s'");
      const old = await db.store.claimObservation('observer');
      await db.admin.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES('u','suspended',1)");
      await db.store.reconcileGovernance({ workerId: 'worker' });
      await assert.rejects(db.store.recordObservation(receipt(old)), /observation_superseded/);
      const [stop] = await db.store.claimCommands('worker', 1);
      await db.store.completeCommand({ workerId: 'worker', commandId: stop.id, leaseAttempt: stop.attempts, status: 'dead' });
      await db.admin.query("UPDATE agent_engine_runs SET stop_requested_at=now()-interval '61s'; UPDATE agent_runtime_controls SET observation_success_at=now()-interval '61s'");
      const snapshot = await db.store.supervisionSnapshot();
      assert.equal(snapshot.deadPending, 1); assert.equal(snapshot.stopOverdue, 1); assert.equal(snapshot.observationStale, 1);
      // Generation change permits an immediate replacement observation.
      lease = await db.store.claimObservation('observer');
      assert.ok(lease);
      await db.store.recordObservation(receipt(lease, 'absent'));
      assert.deepEqual(await db.store.supervisionSnapshot(), { active: 0, stopping: 0, stopOverdue: 0, deadPending: 0, observationErrors: 0, observationStale: 0 });
      assert.equal((await db.admin.query('SELECT status FROM agent_engine_runs WHERE id=$1', [start.runId])).rows[0].status, 'stopped');
      assert.equal((await db.admin.query("SELECT * FROM agent_runtime_control_requests WHERE reason='observed_terminal'")).rowCount, 1);
      await assert.rejects(db.store.recordObservation(receipt(lease)), /observation_lease_lost/);
    });
    await t.test('functions have no public access, no direct table writes, migration rerun preserves state', async () => {
      await assert.rejects(db.pool.query('SELECT * FROM agent_runtime_controls'), { code: '42501' });
      await assert.rejects(db.pool.query('UPDATE agent_engine_runs SET status=\'running\''), { code: '42501' });
      const funcs = (await db.admin.query("SELECT p.proacl::text[] proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname LIKE 'runtime_supervision_%'", [db.schema])).rows;
      assert.equal(funcs.length, 3); assert.ok(funcs.every(row => !row.proacl.some(item => item.startsWith('=X/'))));
      await db.admin.query(await readFile(new URL('../../../packages/db/migrations/040_runtime_supervision.sql', import.meta.url), 'utf8'));
      assert.equal((await db.store.supervisionSnapshot()).active, 0);
    });
    if (process.env.BAIRUI_ORCHESTRATOR_TEST_DATABASE_URL) await t.test('standalone Controller with least-privilege login: real TLS, Docker TTL, crash restart, abnormal exit and governance stop', { timeout: 180000 }, async () => {
      const installationId = process.env.BAIRUI_ORCHESTRATOR_TEST_INSTALLATION;
      const network = process.env.BAIRUI_ORCHESTRATOR_TEST_NETWORK;
      const image = process.env.BAIRUI_ORCHESTRATOR_TEST_IMAGE;
      const machinePool = new Pool({ connectionString: process.env.BAIRUI_ORCHESTRATOR_TEST_DATABASE_URL, max: 4 });
      const ledger = new PostgresOrchestratorLedger({ pool: machinePool, installationId });
      const docker = new DockerOrchestratorDriver({ installationId, network, image });
      let now = Date.now();
      const orchestrator = new Orchestrator({ ledger, docker, clock: () => now });
      const secret = randomBytes(32).toString('hex'), token = randomBytes(32).toString('hex');
      const certFile = process.env.BAIRUI_ORCHESTRATOR_TEST_CERT_FILE;
      const server = createOrchestratorServer({ service: orchestrator, nonceStore: ledger, keys: { primary: secret },
        tls: { cert: await readFile(certFile), key: await readFile(process.env.BAIRUI_ORCHESTRATOR_TEST_KEY_FILE) } });
      const directory = await mkdtemp(join(tmpdir(), 'bairui-e3-controller-'));
      const controllerRole = `controller_${randomUUID().replaceAll('-', '')}`, password = randomBytes(24).toString('hex');
      let child, roleCreated = false, logs = '';
      const cli = async args => (await promisify(execFile)('docker', args, { windowsHide: true, timeout: 15000 })).stdout.trim();
      const until = async check => {
        for (let index = 0; index < 160; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
        assert.fail('controller state did not converge; safe logs: ' + logs);
      };
      try {
        await ledger.check(); await docker.check();
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        await writeFile(join(directory, 'token'), token);
        await db.admin.query(`CREATE ROLE ${controllerRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS;
          GRANT USAGE ON SCHEMA ${db.schema} TO ${controllerRole};
          GRANT EXECUTE ON FUNCTION runtime_control_claim(text,integer),runtime_control_prepare(text,uuid,integer),
            runtime_control_complete(text,uuid,text,text,integer),runtime_control_commit_started(text,uuid,text,text,bigint,text,text,integer),
            runtime_control_commit_stopped(text,uuid,text,text,bigint,bigint,text,timestamptz,integer),runtime_control_reconcile_governance(text,integer),
            runtime_supervision_claim(text),runtime_supervision_record(text,uuid,text,text,bigint,bigint,text,timestamptz,text,text),runtime_supervision_snapshot() TO ${controllerRole}`);
        roleCreated = true;
        await db.admin.query("UPDATE platform_account_governance SET status='active',version=2 WHERE user_id='u'");
        const metricsPort = await unusedLoopbackPort();
        const start = async () => {
          const generation = Number((await db.admin.query('SELECT generation FROM agent_runtime_controls')).rows[0].generation);
          return db.store.requestStart({ actorUserId: 'u', agentId: 'a', expectedGeneration: generation, requestId: randomUUID(), resourceSpec: resources });
        };
        let run = await start();
        const controllerUrl = new URL(process.env.BAIRUI_RUNTIME_CONTROL_TEST_DATABASE_URL);
        controllerUrl.username = controllerRole; controllerUrl.password = password; controllerUrl.searchParams.set('options', `-c search_path=${db.schema},public`);
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|POSTGRES_)/.test(key)) delete env[key];
        Object.assign(env, { BAIRUI_RUNTIME_CONTROLLER_MODE: 'isolation', BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL: controllerUrl.href,
          BAIRUI_RUNTIME_CONTROLLER_METRICS_TOKEN_FILE: join(directory, 'token'), BAIRUI_RUNTIME_CONTROLLER_METRICS_PORT: String(metricsPort),
          BAIRUI_RUNTIME_CONTROLLER_INTERVAL_MS: '100', BAIRUI_RUNTIME_CONTROL_TIMEOUT_MS: '25000',
          BAIRUI_RUNTIME_ALLOWED_HOSTS: containerName(installationId, run.runId),
          BAIRUI_RUNTIME_ORCHESTRATOR_URL: `https://127.0.0.1:${server.address().port}`, BAIRUI_RUNTIME_CONTROL_KEY_ID: 'primary',
          BAIRUI_RUNTIME_CONTROL_SECRET: secret, NODE_EXTRA_CA_CERTS: certFile });
        await assert.rejects(startRuntimeController({ ...env, BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL:
          process.env.BAIRUI_RUNTIME_CONTROL_TEST_DATABASE_URL + `?options=-c%20search_path=${db.schema},public` }), /runtime_controller_role_invalid/);
        await db.admin.query(`GRANT SELECT ON agent_runtime_controls TO ${controllerRole}`);
        try { await assert.rejects(startRuntimeController(env), /runtime_controller_role_invalid/); }
        finally { await db.admin.query(`REVOKE SELECT ON agent_runtime_controls FROM ${controllerRole}`); }
        const launch = async () => {
          env.BAIRUI_RUNTIME_ALLOWED_HOSTS = containerName(installationId, run.runId);
          child = spawn(process.execPath, [fileURLToPath(new URL('../src/runtime/supervision/index.mjs', import.meta.url))],
            { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          child.on('error', () => {});
          child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-2048); });
          child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-2048); });
          await until(async () => { assert.equal(child.exitCode, null); return logs.includes('runtime_controller_isolation_ready'); });
        };
        const ready = async () => (await db.admin.query('SELECT status FROM agent_engine_runs WHERE id=$1', [run.runId])).rows[0].status === 'running';
        const stopped = async () => !(await db.admin.query('SELECT active_run_id FROM agent_runtime_controls')).rows[0].active_run_id;
        const metrics = async () => (await fetch(`http://127.0.0.1:${metricsPort}/metrics`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) })).text();
        await launch(); await until(ready); await until(async () => /bairui_runtime_active 1/.test(await metrics()));
        const firstContainer = (await ledger.read(run.runId)).containerId;
        // Interrupt only this disposable Controller login; retained snapshot and next cycles recover.
        await db.admin.query(`ALTER ROLE ${controllerRole} NOLOGIN`);
        try {
          await db.admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()', [controllerRole]);
          await until(async () => {
            const text = await metrics();
            return /bairui_runtime_controller_cycle_ok 0/.test(text) && /bairui_runtime_active 1/.test(text);
          });
        } finally { await db.admin.query(`ALTER ROLE ${controllerRole} LOGIN`); }
        await until(async () => /bairui_runtime_controller_cycle_ok 1/.test(await metrics()));
        assert.equal((await ledger.read(run.runId)).containerId, firstContainer);
        // Restart while allocated: same platform run and machine container, no new start.
        await killOrchestrator(child); child = null; logs = ''; await launch();
        await until(async () => /bairui_runtime_active 1/.test(await metrics()));
        assert.equal((await ledger.read(run.runId)).containerId, firstContainer);
        now += 61000; await orchestrator.reap();
        await db.admin.query("UPDATE agent_runtime_controls SET observation_next_at=now()-interval '1s'");
        await until(stopped); await until(async () => /bairui_runtime_active 0/.test(await metrics()));
        assert.equal(await cli(['ps', '-a', '--filter', `id=${firstContainer}`, '--format', '{{.ID}}']), '');
        await killOrchestrator(child); child = null;
        run = await start(); logs = ''; await launch(); await until(ready);
        const secondContainer = (await ledger.read(run.runId)).containerId;
        await cli(['kill', secondContainer]); await orchestrator.reap();
        await db.admin.query("UPDATE agent_runtime_controls SET observation_next_at=now()-interval '1s'");
        await until(stopped);
        assert.equal(await cli(['ps', '-a', '--filter', `id=${secondContainer}`, '--format', '{{.ID}}']), '');
        await killOrchestrator(child); child = null;
        run = await start(); logs = ''; await launch(); await until(ready);
        const governedContainer = (await ledger.read(run.runId)).containerId;
        // Use the actual account-governance function in an owner transaction.
        await db.admin.query("INSERT INTO users(id,email) VALUES('e3-admin','e3-admin@example.test'); INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES('e3-admin','platform_admin','test','E3')");
        const governed = (await db.admin.query('SELECT platform_governance_change($1,$2,$3,$4,$5,$6) result',
          ['e3-admin', 'u', 'suspended', 2, 'E3 isolated stop', randomUUID()])).rows[0].result;
        assert.equal(governed.error, undefined);
        await until(stopped);
        assert.equal((await db.admin.query('SELECT * FROM runtime_routes')).rowCount, 0);
        assert.equal(await cli(['ps', '-a', '--filter', `id=${governedContainer}`, '--format', '{{.ID}}']), '');
        await db.admin.query('SELECT platform_governance_change($1,$2,$3,$4,$5,$6)', ['e3-admin', 'u', 'active', 3, 'E3 restore', randomUUID()]);
        await until(async () => /bairui_runtime_active 0/.test(await metrics()));
        assert.equal((await db.admin.query("SELECT * FROM agent_runtime_controls WHERE desired_state='running'")).rowCount, 0);
        assert.ok(!logs.includes(secret) && !logs.includes(password) && !logs.includes(token));
      } finally {
        await killOrchestrator(child); await new Promise(resolve => server.close(resolve)); await machinePool.end();
        if (roleCreated) await db.admin.query(`DROP OWNED BY ${controllerRole}; DROP ROLE ${controllerRole}`);
        assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('bairui-e3-controller-'));
        await rm(directory, { recursive: true, force: true });
      }
    });
  } finally { await db.close(); }
});
