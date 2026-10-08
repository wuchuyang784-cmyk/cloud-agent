import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import { Pool } from 'pg';

import { PostgresRuntimeControlStore } from '../src/runtime/postgres-control-store.mjs';

const connectionString = process.env.BAIRUI_RUNTIME_CONTROL_TEST_DATABASE_URL;
const resourceSpec = Object.freeze({ cpuMillis: 500, memoryBytes: 536870912, pidsLimit: 64, idleTtlSeconds: 900 });

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
      runtime_control_complete(text,uuid,text,text),
      runtime_control_commit_started(text,uuid,text,text,bigint,text,text),
      runtime_control_commit_stopped(text,uuid,text,text,bigint,bigint,text,timestamptz),
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

    await t.test('start, replay, route publication and direct table denial', async () => {
      const requestId = randomUUID();
      const started = await appStore.requestStart({ actorUserId: 'user-1', agentId: 'agent-1', requestId, expectedGeneration: 0, resourceSpec });
      assert.equal(started.result, 'accepted');
      assert.equal(started.generation, 1);
      assert.deepEqual(await appStore.requestStart({ actorUserId: 'user-1', agentId: 'agent-1', requestId, expectedGeneration: 0, resourceSpec }), { ...started, replayed: true });
      const [command] = await controllerStore.claimCommands('controller-a', 10);
      assert.equal(command.eventType, 'runtime.start.requested');
      assert.equal(command.payload.env, undefined);
      const committed = await controllerStore.commitStarted({
        workerId: 'controller-a', requestId: command.requestId, agentId: 'agent-1', runId: started.runId,
        runGeneration: 1, orchestratorRef: 'ref-1', runtimeUrl: 'http://agent-1.runtime.internal:8092',
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
      });
      assert.equal(confirmed.result, 'committed');
      assert.equal((await elevated.query("SELECT active_run_id FROM agent_runtime_controls WHERE agent_id='agent-1'")).rows[0].active_run_id, null);
    });

    await t.test('late start success is fenced and enqueues one compensating stop', async () => {
      const started = await appStore.requestStart({ actorUserId: 'user-1', agentId: 'agent-1', requestId: randomUUID(), expectedGeneration: 2, resourceSpec });
      await appStore.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: randomUUID(), expectedGeneration: 3, reason: 'stop during start' });
      const result = await controllerStore.commitStarted({
        workerId: 'controller-a', requestId: started.commandRequestId, agentId: 'agent-1', runId: started.runId,
        runGeneration: 3, orchestratorRef: 'late-ref', runtimeUrl: 'http://late.runtime.internal:8092',
      });
      assert.equal(result.result, 'stale_stop_enqueued');
      assert.equal((await elevated.query("SELECT count(*)::int n FROM runtime_routes WHERE agent_id='agent-1'")).rows[0].n, 0);
      assert.equal((await elevated.query("SELECT count(*)::int n FROM control_outbox WHERE event_type='runtime.stop.requested' AND payload->>'runId'=$1", [started.runId])).rows[0].n, 1);
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
      await controllerStore.commitStarted({
        workerId: 'controller-b', requestId: started.commandRequestId, agentId: 'agent-2', runId: started.runId,
        runGeneration: 1, orchestratorRef: 'ref-governed', runtimeUrl: 'http://agent-2.runtime.internal:8092',
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
