import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import { Pool } from 'pg';

import { PostgresRuntimeControlStore } from '../src/runtime/postgres-control-store.mjs';
import { PostgresStore } from '../src/postgres-store.mjs';
import { RuntimeController } from '../src/runtime/controller.mjs';
import { RemoteRuntimeDriver } from '../src/runtime/orchestration/remote-driver.mjs';
import { FakeRuntimeOrchestrator } from './helpers/fake-runtime-orchestrator.mjs';

const connectionString = process.env.BAIRUI_RUNTIME_CONTROL_TEST_DATABASE_URL;
const resourceSpec = Object.freeze({ cpuMillis: 500, memoryBytes: 536870912, pidsLimit: 64, idleTtlSeconds: 900 });

function track(promise) {
  const operation = { settled: false };
  operation.promise = promise.finally(() => { operation.settled = true; });
  operation.promise.catch(() => {});
  return operation;
}

async function assertBlocked(observer, waiter, blocker, operation) {
  for (let index = 0; index < 150; index += 1) {
    if ((await observer.query('SELECT $2::integer=ANY(pg_blocking_pids($1)) blocked', [waiter, blocker])).rows[0].blocked) return;
    assert.equal(operation.settled, false, 'transaction bypassed the governance lock');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('governance lock wait was not observed');
}

for (const rollbackFails of [false, true]) {
  test(`runtime control transactions: bounded READ COMMITTED and rollback cleanup (${rollbackFails})`, async () => {
    const calls = []; const releases = [];
    const rollbackError = new Error('rollback_failed');
    const pool = { query: async () => { throw new Error('must_checkout'); }, connect: async () => ({
      query: async sql => {
        calls.push(sql);
        if (sql === 'ROLLBACK') { if (rollbackFails) throw rollbackError; return { rows: [] }; }
        if (sql.startsWith('SELECT * FROM runtime_control_claim')) throw Object.assign(new Error('private_database_detail'), { code: '57014' });
        return { rows: [] };
      }, release: error => releases.push(error),
    }) };
    await assert.rejects(() => new PostgresRuntimeControlStore({ pool }).claimCommands('test', 1), { code: 'runtime_control_timeout' });
    assert.equal(calls[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
    assert.ok(calls.some(sql => sql.includes('statement_timeout')));
    assert.equal(calls.at(-1), 'ROLLBACK');
    assert.deepEqual(releases, [rollbackFails ? rollbackError : undefined]);
  });
}

function rolePool(url, schema, role, max = 2) {
  return new Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 2000,
    query_timeout: 3000,
    options: `-c search_path=${schema},public -c role=${role}`,
  });
}

test('runtime control PostgreSQL: migration, fenced transitions and least privilege', { skip: !connectionString }, async (t) => {
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `runtime_${suffix}`;
  const appRole = `runtime_app_${suffix}`;
  const controllerRole = `runtime_controller_${suffix}`;
  const owner = new Pool({ connectionString });
  let elevated;
  let appPool;
  let controllerPool;
  try {
    await owner.query(`CREATE SCHEMA ${schema}`);
    elevated = new Pool({ connectionString, options: `-c search_path=${schema},public` });
    const migrations = new URL('../../../packages/db/migrations/', import.meta.url);
    const names = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of names) await elevated.query(await readFile(new URL(name, migrations), 'utf8'));

    await owner.query(`CREATE ROLE ${appRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`CREATE ROLE ${controllerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await elevated.query(`GRANT USAGE ON SCHEMA ${schema} TO ${appRole},${controllerRole}`);
    await elevated.query(`GRANT EXECUTE ON FUNCTION
      runtime_control_request_start(text,text,uuid,bigint,integer,bigint,integer,integer),
      runtime_control_request_stop(text,text,uuid,bigint,text)
      TO ${appRole}`);
    await elevated.query(`GRANT EXECUTE ON FUNCTION
      runtime_control_claim(text,integer),
      runtime_control_prepare(text,uuid,integer),
      runtime_control_complete(text,uuid,text,text,integer),
      runtime_control_commit_started(text,uuid,text,text,bigint,text,text,integer),
      runtime_control_commit_stopped(text,uuid,text,text,bigint,bigint,text,timestamptz,integer),
      runtime_control_reconcile_governance(text,integer)
      TO ${controllerRole}`);

    await elevated.query(`
      INSERT INTO organizations(id,name) VALUES('org-1','Runtime test');
      INSERT INTO users(id,email,display_name,auth_subject) VALUES
        ('user-1','runtime@example.test','Runtime Owner','better-auth:runtime-auth-1'),
        ('user-2','governed@example.test','Governed Owner','better-auth:runtime-auth-2');
      INSERT INTO organization_members(organization_id,user_id,role) VALUES
        ('org-1','user-1','user'),('org-1','user-2','user');
      INSERT INTO agents(id,organization_id,owner_user_id,name,status,runtime_kind,engine,template_version,host)
        VALUES('agent-1','org-1','user-1','Runtime Agent','stopped','pi','pi',1,'agent-agent-1.example.test'),
              ('agent-2','org-1','user-2','Governed Agent','stopped','pi','pi',1,'agent-agent-2.example.test'),
              ('agent-3','org-1','user-1','Concurrent Agent','stopped','pi','pi',1,'agent-agent-3.example.test');
      INSERT INTO agent_memberships(organization_id,agent_id,user_id,role) VALUES
        ('org-1','agent-1','user-1','owner'),('org-1','agent-2','user-2','owner'),('org-1','agent-3','user-1','owner');
    `);

    appPool = rolePool(connectionString, schema, appRole, 2);
    controllerPool = rolePool(connectionString, schema, controllerRole, 2);
    const appStore = new PostgresRuntimeControlStore({ pool: appPool });
    const controllerStore = new PostgresRuntimeControlStore({ pool: controllerPool });

    await elevated.query("INSERT INTO users(id,email) VALUES('runtime-admin','runtime-admin@example.test')");
    await elevated.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES('runtime-admin','platform_admin','test-fixture','E1 isolated test')");
    await elevated.query(`GRANT EXECUTE ON FUNCTION platform_governance_change(text,text,text,integer,text,uuid) TO ${appRole}`);
    const govern = async (client, userId) => {
      const result = (await client.query('SELECT platform_governance_change($1,$2,$3,$4,$5,$6) result',
        ['runtime-admin', userId, 'banned', 0, 'E1 lock test', randomUUID()])).rows[0].result;
      assert.equal(result.error, undefined);
      return result;
    };
    const seedLockRun = async (number, requestId = randomUUID()) => {
      const userId = `lock-user-${number}`, agentId = `lock-agent-${number}`;
      await elevated.query('INSERT INTO users(id,email) VALUES($1,$2)', [userId, `${userId}@example.test`]);
      await elevated.query("INSERT INTO agents(id,organization_id,owner_user_id,name,status,runtime_kind,engine,template_version,host) VALUES($1,'org-1',$2,'Lock Agent','stopped','pi','pi',1,$3)", [agentId, userId, `${agentId}.example.test`]);
      const started = await appStore.requestStart({ actorUserId: userId, agentId, requestId, expectedGeneration: 0, resourceSpec });
      const command = (await controllerStore.claimCommands('lock-worker', 100)).find(row => row.requestId === started.commandRequestId);
      return { userId, agentId, command, receipt: { ...command.payload, workerId: 'lock-worker', requestId: command.requestId,
        leaseAttempt: command.attempts, orchestratorRef: 'lock-ref', runtimeUrl: 'http://lock.runtime.internal:8092' } };
    };

    await t.test('in-flight real governance fences receipt under repeatable-read connection default', async () => {
      const { userId, agentId, receipt } = await seedLockRun(1);
      const governor = await appPool.connect(), worker = await controllerPool.connect();
      let pending;
      try {
        await governor.query('BEGIN');
        await govern(governor, userId);
        const governorPid = (await governor.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const workerPid = (await worker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await worker.query("SET default_transaction_isolation='repeatable read'");
        const store = new PostgresRuntimeControlStore({ pool: { connect: async () => ({ query: worker.query.bind(worker), release() {} }) } });
        pending = track(store.commitStarted(receipt));
        await assertBlocked(elevated, workerPid, governorPid, pending);
        await governor.query('COMMIT');
        assert.equal((await pending.promise).result, 'stale_stop_enqueued');
        assert.equal((await elevated.query('SELECT count(*)::int n FROM runtime_routes WHERE agent_id=$1', [agentId])).rows[0].n, 0);
      } finally {
        await governor.query('ROLLBACK'); await pending?.promise.catch(() => {});
        await worker.query('RESET default_transaction_isolation'); worker.release(); governor.release();
      }
      await elevated.query('DELETE FROM agents WHERE id=$1', [agentId]);
      await elevated.query('DELETE FROM control_outbox WHERE aggregate_id=$1', [agentId]);
    });

    await t.test('real governance waits for admitted receipt transaction to commit', async () => {
      const { userId, agentId, receipt } = await seedLockRun(2);
      const worker = await controllerPool.connect(), governor = await appPool.connect();
      const ready = Promise.withResolvers(), gate = Promise.withResolvers();
      let pending; let change;
      try {
        const workerPid = (await worker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const governorPid = (await governor.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const store = new PostgresRuntimeControlStore({ pool: { connect: async () => ({
          async query(sql, args) {
            const result = await worker.query(sql, args);
            if (sql.startsWith('SELECT runtime_control_commit_started')) { ready.resolve(); await gate.promise; }
            return result;
          }, release() {},
        }) } });
        pending = track(store.commitStarted(receipt));
        await Promise.race([ready.promise, pending.promise.then(() => assert.fail('receipt skipped governance'))]);
        change = track(govern(governor, userId));
        await assertBlocked(elevated, governorPid, workerPid, change);
        gate.resolve();
        assert.equal((await pending.promise).result, 'committed');
        await change.promise;
        await controllerStore.reconcileGovernance({ workerId: 'lock-worker', limit: 100 });
        assert.equal((await elevated.query('SELECT count(*)::int n FROM runtime_routes WHERE agent_id=$1', [agentId])).rows[0].n, 0);
      } finally {
        gate.resolve(); await Promise.allSettled([pending?.promise, change?.promise]); worker.release(); governor.release();
      }
      await elevated.query('DELETE FROM agents WHERE id=$1', [agentId]);
      await elevated.query('DELETE FROM control_outbox WHERE aggregate_id=$1', [agentId]);
    });

    await t.test('reconcile skips a locked Agent before taking control or audit foreign-key locks', async () => {
      const { userId, agentId } = await seedLockRun(3);
      await govern(appPool, userId);
      const blocker = await elevated.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [agentId]);
        assert.deepEqual(await controllerStore.reconcileGovernance({ workerId: 'lock-worker', limit: 100 }), { stopped: 0, started: 0 });
        await blocker.query('COMMIT');
        assert.deepEqual(await controllerStore.reconcileGovernance({ workerId: 'lock-worker', limit: 100 }), { stopped: 1, started: 0 });
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      await elevated.query('DELETE FROM agents WHERE id=$1', [agentId]);
      await elevated.query('DELETE FROM control_outbox WHERE aggregate_id=$1', [agentId]);
    });

    await t.test('caller-chosen request UUID cannot suppress the system governance stop command', async () => {
      const hex = createHash('md5').update('lock-user-4:1:lock-agent-4').digest('hex');
      const chosenId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const { userId, agentId } = await seedLockRun(4, chosenId);
      await govern(appPool, userId);
      assert.equal((await controllerStore.reconcileGovernance({ workerId: 'lock-worker', limit: 100 })).stopped, 1);
      const stops = (await elevated.query("SELECT request_id FROM control_outbox WHERE aggregate_id=$1 AND event_type='runtime.stop.requested'", [agentId])).rows;
      assert.equal(stops.length, 1);
      assert.notEqual(stops[0].request_id, chosenId);
      assert.equal((await controllerStore.reconcileGovernance({ workerId: 'lock-worker', limit: 100 })).stopped, 0);
      await elevated.query('DELETE FROM agents WHERE id=$1', [agentId]);
      await elevated.query('DELETE FROM control_outbox WHERE aggregate_id=$1', [agentId]);
    });

    await t.test('real HTTP unknown START exhaustion persists cleanup atomically with restricted PostgreSQL credentials', async () => {
      await elevated.query(`INSERT INTO agents(id,organization_id,owner_user_id,name,status,runtime_kind,engine,template_version,host)
        VALUES('agent-4','org-1','user-1','Recovery Agent','stopped','pi','pi',1,'agent-4.example.test')`);
      const secret = 'runtime-postgres-test-secret-at-least-32-characters';
      const orchestrator = new FakeRuntimeOrchestrator({ secret });
      const origin = await orchestrator.listen();
      try {
        const driver = new RemoteRuntimeDriver({ env: { NODE_ENV: 'test' }, orchestratorUrl: origin,
          orchestratorKeyId: 'primary', orchestratorSecret: secret, allowedRuntimeHosts: ['agent-4.runtime.internal'], allowInsecureHttp: true });
        const controller = new RuntimeController({ store: controllerStore, driver, workerId: 'recovery-test', batchSize: 1, maxAttempts: 1 });
        const started = await appStore.requestStart({ actorUserId: 'user-1', agentId: 'agent-4', requestId: randomUUID(), expectedGeneration: 0, resourceSpec });
        orchestrator.dropNext('PUT');
        orchestrator.failNext('GET');
        assert.equal((await controller.tick()).dead, 1);
        assert.equal(orchestrator.run(started.runId).status, 'running');
        const control = (await elevated.query("SELECT desired_state,generation::int,active_run_id FROM agent_runtime_controls WHERE agent_id='agent-4'")).rows[0];
        assert.deepEqual(control, { desired_state: 'stopped', generation: 2, active_run_id: started.runId });
        assert.equal((await elevated.query("SELECT count(*)::int n FROM agent_runtime_control_requests WHERE agent_id='agent-4' AND action='recovery_stop'")).rows[0].n, 1);
        assert.equal((await controller.tick()).succeeded, 1);
        assert.equal(orchestrator.run(started.runId).status, 'stopped');
        assert.equal((await elevated.query('SELECT status FROM agent_engine_runs WHERE id=$1', [started.runId])).rows[0].status, 'stopped');
      } finally { await orchestrator.close(); }
    });

    await t.test('start, replay, route publication and direct table denial', async () => {
      const requestId = randomUUID();
      const started = await appStore.requestStart({ actorUserId: 'user-1', agentId: 'agent-1', requestId, expectedGeneration: 0, resourceSpec });
      assert.equal(started.result, 'accepted');
      assert.equal(started.generation, 1);
      assert.deepEqual(await appStore.requestStart({ actorUserId: 'user-1', agentId: 'agent-1', requestId, expectedGeneration: 0, resourceSpec }), { ...started, replayed: true });
      const legacy = new PostgresStore({ pool: elevated });
      assert.deepEqual(await legacy.claimOutbox('old-worker', 100), [], 'legacy worker must not consume Runtime control commands');
      const [command] = await controllerStore.claimCommands('controller-a', 10);
      assert.equal(command.eventType, 'runtime.start.requested');
      assert.equal(command.payload.env, undefined);
      const committed = await controllerStore.commitStarted({
        workerId: 'controller-a', requestId: command.requestId, agentId: 'agent-1', runId: started.runId,
        runGeneration: 1, orchestratorRef: 'ref-1', runtimeUrl: 'http://agent-1.runtime.internal:8092',
        leaseAttempt: command.attempts,
      });
      assert.equal(committed.result, 'committed');
      assert.equal((await elevated.query("SELECT route_version::int version FROM runtime_routes WHERE agent_id='agent-1'")).rows[0].version, 1);
      await assert.rejects(appPool.query('SELECT * FROM agent_runtime_controls'), { code: '42501' });
      await assert.rejects(controllerPool.query('SELECT * FROM agent_runtime_control_requests'), { code: '42501' });
    });

    await t.test('stop removes route before confirmation and only confirmation clears active run', async () => {
      const stopped = await appStore.requestStop({
        actorUserId: 'user-1', agentId: 'agent-1', requestId: randomUUID(), expectedGeneration: 1, reason: 'manual stop',
      });
      assert.equal(stopped.generation, 2);
      assert.equal((await elevated.query("SELECT count(*)::int n FROM runtime_routes WHERE agent_id='agent-1'")).rows[0].n, 0);
      assert.equal((await elevated.query('SELECT status FROM agent_engine_runs WHERE id=$1', [stopped.runId])).rows[0].status, 'stopping');
      assert.equal((await elevated.query("SELECT active_run_id IS NOT NULL active FROM agent_runtime_controls WHERE agent_id='agent-1'")).rows[0].active, true);
      const [stopCommand] = (await controllerStore.claimCommands('controller-a', 10)).filter((row) => row.eventType === 'runtime.stop.requested');
      const confirmed = await controllerStore.commitStopped({
        workerId: 'controller-a', requestId: stopCommand.requestId, agentId: 'agent-1', runId: stopped.runId,
        runGeneration: 1, fenceGeneration: 2, status: 'absent', confirmedAt: '2026-10-08T00:00:00.000Z',
        leaseAttempt: stopCommand.attempts,
      });
      assert.equal(confirmed.result, 'committed');
      assert.equal((await elevated.query("SELECT active_run_id FROM agent_runtime_controls WHERE agent_id='agent-1'")).rows[0].active_run_id, null);
    });

    await t.test('late start success is fenced and enqueues one compensating stop', async () => {
      const started = await appStore.requestStart({ actorUserId: 'user-1', agentId: 'agent-1', requestId: randomUUID(), expectedGeneration: 2, resourceSpec });
      await appStore.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: randomUUID(), expectedGeneration: 3, reason: 'stop during start' });
      await controllerStore.claimCommands('controller-a', 100);
      const result = await controllerStore.commitStarted({
        workerId: 'controller-a', requestId: started.commandRequestId, agentId: 'agent-1', runId: started.runId,
        runGeneration: 3, orchestratorRef: 'late-ref', runtimeUrl: 'http://late.runtime.internal:8092',
        leaseAttempt: 1,
      });
      assert.equal(result.result, 'stale_stop_enqueued');
      assert.equal((await elevated.query("SELECT count(*)::int n FROM runtime_routes WHERE agent_id='agent-1'")).rows[0].n, 0);
      assert.equal((await elevated.query("SELECT count(*)::int n FROM control_outbox WHERE event_type='runtime.stop.requested' AND payload->>'runId'=$1", [started.runId])).rows[0].n, 1);
      const oldStop = (await elevated.query("SELECT * FROM control_outbox WHERE event_type='runtime.stop.requested' AND payload->>'runId'=$1", [started.runId])).rows[0];
      const stoppedReceipt = { ...oldStop.payload, requestId: oldStop.request_id, workerId: 'controller-a', leaseAttempt: oldStop.attempts,
        status: 'stopped', confirmedAt: new Date().toISOString() };
      await controllerStore.commitStopped(stoppedReceipt);
      const next = await appStore.requestStart({ actorUserId: 'user-1', agentId: 'agent-1', requestId: randomUUID(), expectedGeneration: 4, resourceSpec });
      const nextCommand = (await controllerStore.claimCommands('controller-a', 100)).find(row => row.requestId === next.commandRequestId);
      await controllerStore.commitStarted({ ...nextCommand.payload, workerId: 'controller-a', requestId: nextCommand.requestId,
        leaseAttempt: nextCommand.attempts, orchestratorRef: 'new-ref', runtimeUrl: 'http://new.runtime.internal:8092' });
      await controllerStore.commitStopped(stoppedReceipt);
      await controllerStore.commitStarted({ ...started, agentId: 'agent-1', runGeneration: 3, workerId: 'controller-a', requestId: started.commandRequestId,
        leaseAttempt: 1, orchestratorRef: 'late-ref', runtimeUrl: 'http://late.runtime.internal:8092' });
      assert.equal((await elevated.query("SELECT route_version::int v FROM runtime_routes WHERE agent_id='agent-1'")).rows[0].v, 5);
      assert.equal((await elevated.query("SELECT active_run_id FROM agent_runtime_controls WHERE agent_id='agent-1'")).rows[0].active_run_id, next.runId);
      await appStore.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: randomUUID(), expectedGeneration: 5, reason: 'test cleanup' });
    });

    await t.test('concurrent starts serialize to one run and one generation', async () => {
      const attempts = await Promise.allSettled([
        appStore.requestStart({ actorUserId: 'user-1', agentId: 'agent-3', requestId: randomUUID(), expectedGeneration: 0, resourceSpec }),
        appStore.requestStart({ actorUserId: 'user-1', agentId: 'agent-3', requestId: randomUUID(), expectedGeneration: 0, resourceSpec }),
      ]);
      assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
      assert.equal(attempts.filter((item) => item.status === 'rejected' && item.reason.code === 'runtime_generation_conflict').length, 1);
      assert.equal((await elevated.query("SELECT count(*)::int n FROM agent_engine_runs WHERE agent_id='agent-3' AND run_generation=1")).rows[0].n, 1);
      assert.equal((await elevated.query("SELECT count(*)::int n FROM control_outbox WHERE aggregate_id='agent-3' AND event_type='runtime.start.requested'")).rows[0].n, 1);
    });

    await t.test('governance notification commits, rollback stays silent, and reconcile atomically fences runtime', async () => {
      const started = await appStore.requestStart({ actorUserId: 'user-2', agentId: 'agent-2', requestId: randomUUID(), expectedGeneration: 0, resourceSpec });
      await controllerStore.claimCommands('controller-b', 100);
      await controllerStore.commitStarted({
        workerId: 'controller-b', requestId: started.commandRequestId, agentId: 'agent-2', runId: started.runId,
        runGeneration: 1, orchestratorRef: 'ref-governed', runtimeUrl: 'http://agent-2.runtime.internal:8092',
        leaseAttempt: 1,
      });
      const listener = await owner.connect();
      try {
        await listener.query('LISTEN bairui_runtime_governance');
        const notifications = [];
        listener.on('notification', (message) => notifications.push(message.payload));
        await elevated.query('BEGIN');
        await elevated.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES('user-2','banned',1)");
        await elevated.query('ROLLBACK');
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(notifications, []);

        await elevated.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES('user-2','suspended',1)");
        for (let wait = 0; notifications.length === 0 && wait < 20; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(notifications, ['user-2']);

        await elevated.query("ALTER TABLE control_outbox ADD CONSTRAINT runtime_reconcile_rollback CHECK (NOT (aggregate_id='agent-2' AND event_type='runtime.stop.requested')) NOT VALID");
        await assert.rejects(() => controllerStore.reconcileGovernance({ workerId: 'controller-b', limit: 20 }));
        assert.equal((await elevated.query("SELECT desired_state FROM agent_runtime_controls WHERE agent_id='agent-2'")).rows[0].desired_state, 'running');
        assert.equal((await elevated.query("SELECT count(*)::int n FROM runtime_routes WHERE agent_id='agent-2'")).rows[0].n, 1);
        await elevated.query('ALTER TABLE control_outbox DROP CONSTRAINT runtime_reconcile_rollback');

        assert.deepEqual(await controllerStore.reconcileGovernance({ workerId: 'controller-b', limit: 20 }), { stopped: 1, started: 0 });
        assert.equal((await elevated.query("SELECT desired_state FROM agent_runtime_controls WHERE agent_id='agent-2'")).rows[0].desired_state, 'stopped');
        assert.equal((await elevated.query("SELECT count(*)::int n FROM runtime_routes WHERE agent_id='agent-2'")).rows[0].n, 0);
        assert.equal((await elevated.query('SELECT status FROM agent_engine_runs WHERE id=$1', [started.runId])).rows[0].status, 'stopping');

        const startsBefore = (await elevated.query("SELECT count(*)::int n FROM control_outbox WHERE aggregate_id='agent-2' AND event_type='runtime.start.requested'")).rows[0].n;
        await elevated.query("UPDATE platform_account_governance SET status='active',version=2 WHERE user_id='user-2'");
        assert.deepEqual(await controllerStore.reconcileGovernance({ workerId: 'controller-b', limit: 20 }), { stopped: 0, started: 0 });
        const startsAfter = (await elevated.query("SELECT count(*)::int n FROM control_outbox WHERE aggregate_id='agent-2' AND event_type='runtime.start.requested'")).rows[0].n;
        assert.equal(startsAfter, startsBefore);
      } finally {
        listener.release();
      }
    });

    await t.test('controller role cannot read authentication or resource contents', async () => {
      await assert.rejects(controllerPool.query('SELECT * FROM ba_session'), { code: '42501' });
      await assert.rejects(controllerPool.query('SELECT * FROM client_resource_contents'), { code: '42501' });
      await assert.rejects(appPool.query("UPDATE agent_runtime_controls SET desired_state='running'"), { code: '42501' });
    });

    await t.test('receipt rejects lost leases even when the same worker id reclaims', async () => {
      const command = (await elevated.query("SELECT * FROM control_outbox WHERE aggregate_id='agent-3' AND event_type='runtime.start.requested'")).rows[0];
      await elevated.query("UPDATE control_outbox SET lease_until=now()-interval '1 second' WHERE id=$1", [command.id]);
      await controllerStore.claimCommands('controller-b', 100);
      await assert.rejects(() => controllerStore.commitStarted({ workerId: 'controller-b', requestId: command.request_id,
        agentId: 'agent-3', runId: command.payload.runId, runGeneration: 1, orchestratorRef: 'expired',
        runtimeUrl: 'http://agent-3.runtime.internal:8092', leaseAttempt: 1 }), { code: 'runtime_command_lease_lost' });
      assert.equal(await controllerStore.completeCommand({ workerId: 'controller-b', commandId: command.id, leaseAttempt: 1, status: 'succeeded' }), false);
      assert.equal((await elevated.query("SELECT count(*)::int n FROM runtime_routes WHERE agent_id='agent-3'")).rows[0].n, 0);
    });

    await t.test('governance version fences pause and restore between controller ticks', async () => {
      await elevated.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES('user-1','suspended',1)");
      await elevated.query("UPDATE platform_account_governance SET status='active',version=2 WHERE user_id='user-1'");
      const result = await controllerStore.reconcileGovernance({ workerId: 'controller-b', limit: 100 });
      assert.equal(result.stopped, 1);
      assert.equal((await elevated.query("SELECT desired_state FROM agent_runtime_controls WHERE agent_id='agent-3'")).rows[0].desired_state, 'stopped');
      const command = (await elevated.query("SELECT * FROM control_outbox WHERE aggregate_id='agent-3' AND event_type='runtime.start.requested'")).rows[0];
      assert.deepEqual(await controllerStore.prepareCommand({ workerId: 'controller-b', requestId: command.request_id, leaseAttempt: command.attempts }), { eligible: false, reason: 'superseded' });
    });

    await t.test('generation zero history coexists and migration rerun preserves grants', async () => {
      await elevated.query(`INSERT INTO agent_engine_runs(id,organization_id,agent_id,engine,template_version,status,subdomain,desired_state)
        VALUES('historical-1','org-1','agent-1','pi',1,'stopped','history-1.example.test','stopped'),
              ('historical-2','org-1','agent-1','pi',1,'stopped','history-2.example.test','stopped')`);
      const before = (await elevated.query("SELECT proacl::text acl FROM pg_proc WHERE oid='runtime_control_request_start(text,text,uuid,bigint,integer,bigint,integer,integer)'::regprocedure")).rows[0].acl;
      await elevated.query(await readFile(new URL('039_runtime_control_fencing.sql', migrations), 'utf8'));
      const after = (await elevated.query("SELECT proacl::text acl FROM pg_proc WHERE oid='runtime_control_request_start(text,text,uuid,bigint,integer,bigint,integer,integer)'::regprocedure")).rows[0].acl;
      assert.equal(after, before);
      assert.equal((await elevated.query("SELECT count(*)::int n FROM agent_engine_runs WHERE run_generation=0")).rows[0].n, 2);
    });
  } finally {
    await appPool?.end();
    await controllerPool?.end();
    await elevated?.end();
    await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await owner.query(`DROP ROLE IF EXISTS ${appRole}`);
    await owner.query(`DROP ROLE IF EXISTS ${controllerRole}`);
    await owner.end();
  }
});
