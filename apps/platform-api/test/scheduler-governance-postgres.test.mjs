import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PostgresTaskStore } from '../src/scheduler/task-store.mjs';

const input = { durationMs: 2000, outcome: 'success' };
const changeSql = 'SELECT platform_governance_change($1,$2,$3,$4,$5,$6) AS result';
const changeArgs = (userId, status, version) => ['admin', userId, status, version, 'D2 isolated test', randomUUID()];

function track(promise) {
  const operation = { settled: false };
  operation.promise = promise.finally(() => { operation.settled = true; });
  // A failing operation must still be observed by its caller after lock cleanup.
  operation.promise.catch(() => {});
  return operation;
}

async function assertBlocked(observer, waiter, blocker, operation) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query('SELECT $2::integer = ANY(pg_blocking_pids($1)) AS blocked', [waiter, blocker]);
    if (rows[0].blocked) return;
    assert.equal(operation.settled, false, 'operation committed without waiting for the governance/scheduler transaction');
    await delay(10);
  }
  assert.fail('expected database blocking relationship was not observed');
}

// All state lives in a disposable test database, never the business .env.
test('PostgreSQL D2: governance cancellation, least privilege and concurrent receipts', {
  skip: !process.env.BAIRUI_SCHEDULER_TEST_DATABASE_URL,
  timeout: 60000,
}, async t => {
  const connectionString = process.env.BAIRUI_SCHEDULER_TEST_DATABASE_URL;
  const suffix = randomUUID().replaceAll('-', '');
  const schema = 'scheduler_d2_' + suffix, role = 'scheduler_d2_role_' + suffix;
  const admin = new Pool({ connectionString });
  let owner, p1, p2;
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    await admin.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    owner = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    const dir = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) {
      await owner.query(await readFile(new URL(name, dir), 'utf8'));
    }
    await owner.query("INSERT INTO users(id,email) VALUES ('admin','d2-admin@example.test')");
    await owner.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES ('admin','platform_admin','test-fixture','D2 isolated test')");
    await admin.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
    await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON simulation_tasks,simulation_tenants TO ' + role);
    await owner.query('GRANT EXECUTE ON FUNCTION platform_scheduler_account_access(text), platform_governance_change(text,text,text,integer,text,uuid) TO ' + role);
    const options = { connectionString, max: 2, options: '-c search_path=' + schema + ',public -c role=' + role };
    p1 = new Pool(options); p2 = new Pool(options);
    const stores = [new PostgresTaskStore(p1), new PostgresTaskStore(p2)];
    let counter = 0;
    const seed = async () => {
      const scope = { userId: 'u' + ++counter, organizationId: 'o' + counter };
      await owner.query('INSERT INTO users(id,email) VALUES ($1,$2)', [scope.userId, scope.userId + '@example.test']);
      await owner.query('INSERT INTO organizations(id,name) VALUES ($1,$1)', [scope.organizationId]);
      await owner.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES ($1,$2,'org_admin')", [scope.organizationId, scope.userId]);
      return scope;
    };
    const govern = async (scope, status, version, client = p2) => {
      const result = (await client.query(changeSql, changeArgs(scope.userId, status, version))).rows[0].result;
      assert.equal(result.error, undefined);
      assert.equal(result.account.status, status);
      assert.equal(result.account.version, version + 1);
      return result;
    };
    const scenario = async (name, fn) => t.test(name, async () => {
      try { await fn(); }
      finally { await owner.query('TRUNCATE simulation_tasks,simulation_tenants'); }
    });

    await scenario('restricted pools cannot read governance tables or another user task', async () => {
      const privilege = (await p1.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      assert.deepEqual(privilege, { rolsuper: false, rolbypassrls: false });
      for (const table of ['platform_account_governance', 'platform_governance_audit', 'platform_role_bindings']) {
        await assert.rejects(p1.query('SELECT * FROM ' + table), { code: '42501' });
      }
      const a = await seed(), b = await seed();
      const task = await stores[0].submit(a, 'private', input);
      assert.equal((await p1.query('SELECT * FROM simulation_tasks')).rowCount, 0);
      assert.equal(await stores[1].get(b, task.id), null);
      assert.equal(await stores[1].cancel(b, task.id), null);
    });

    for (const status of ['suspended', 'banned']) {
      await scenario(`${status} cancels queued/running tasks and fences every old receipt`, async () => {
        const scope = await seed();
        const task = await stores[0].submit(scope, 'running', input);
        const claim = await stores[1].claim('old-worker');
        const queued = await stores[0].submit(scope, 'queued', input);
        await govern(scope, status, 0);
        // Read-only requests do not silently run reconciliation.
        assert.equal((await stores[1].get(scope, task.id)).status, 'running');
        assert.equal(await stores[0].heartbeat(claim), false);
        assert.equal(await stores[1].finish(claim, 'succeeded'), false);
        assert.equal(await stores[1].finish(claim, 'failed'), false);
        assert.equal(await stores[0].claim('new-worker'), null);
        for (const id of [task.id, queued.id]) {
          const cancelled = await new PostgresTaskStore(p2).get(scope, id);
          assert.equal(cancelled.status, 'cancelled');
          assert.equal(cancelled.cancelReason, 'account_' + status);
          assert.ok(Number.isFinite(cancelled.cancelledAt));
          assert.equal(cancelled.workerId, null);
          assert.equal(cancelled.leaseUntil, null);
          assert.equal(cancelled.governanceVersion, 0);
        }
        await assert.rejects(stores[0].submit(scope, 'blocked', input), new RegExp('account_' + status));
        await assert.rejects(stores[0].cancel(scope, queued.id), new RegExp('account_' + status));
        await govern(scope, 'active', 1);
        assert.equal(await stores[0].claim('restored-worker'), null);
        assert.equal((await stores[0].submit(scope, 'running', input)).status, 'cancelled');
        const fresh = await stores[0].submit(scope, 'fresh', input);
        assert.equal(fresh.governanceVersion, 2);
        assert.equal((await stores[1].claim('restored-worker')).id, fresh.id);
        assert.equal(await stores[0].finish(claim, 'succeeded'), false);
      });
    }

    await scenario('suspend and restore before reconciliation still fence old queued/running work', async () => {
      const scope = await seed();
      await stores[0].submit(scope, 'old-running', input);
      const claim = await stores[1].claim('old-worker');
      await stores[0].submit(scope, 'old-queued', input);
      await govern(scope, 'suspended', 0);
      await govern(scope, 'active', 1);
      assert.equal(await stores[1].finish(claim, 'succeeded'), false);
      for (const task of await stores[0].list(scope)) {
        assert.equal(task.status, 'cancelled');
        assert.equal(task.cancelReason, 'governance_changed');
      }
      assert.equal(await stores[1].claim('restored'), null);
    });

    await scenario('governance takes precedence over final lease expiry in PostgreSQL', async () => {
      const scope = await seed();
      const task = await stores[0].submit(scope, 'expired', input);
      let claim;
      for (let attempt = 1; attempt <= 3; attempt++) {
        claim = await stores[0].claim('expiring-worker');
        assert.equal(claim.attempt, attempt);
        await owner.query('UPDATE simulation_tasks SET "leaseUntil"=0 WHERE id=$1', [task.id]);
      }
      await govern(scope, 'banned', 0);
      assert.equal(await stores[1].finish(claim, 'succeeded'), false);
      const cancelled = await stores[0].get(scope, task.id);
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.cancelReason, 'account_banned');
    });

    await scenario('revoked governance function fails closed and rolls back all task changes', async () => {
      const scope = await seed();
      const task = await stores[0].submit(scope, 'permission', input);
      const claim = await stores[1].claim('worker');
      const before = await stores[0].get(scope, task.id);
      await owner.query('REVOKE EXECUTE ON FUNCTION platform_scheduler_account_access(text) FROM ' + role);
      try {
        for (const operation of [() => stores[0].submit(scope, 'denied', input), () => stores[1].claim('denied'),
          () => stores[0].heartbeat(claim), () => stores[1].finish(claim, 'succeeded'), () => stores[0].cancel(scope, task.id)]) {
          await assert.rejects(operation(), /governance_unavailable/);
        }
        assert.deepEqual(await stores[1].get(scope, task.id), before);
        assert.equal((await stores[0].list(scope)).length, 1);
      } finally {
        await owner.query('GRANT EXECUTE ON FUNCTION platform_scheduler_account_access(text) TO ' + role);
      }
      assert.equal(await stores[1].finish(claim, 'succeeded'), true);
    });

    await scenario('governance already in flight fences receipts even with a repeatable-read connection default', async () => {
      const scope = await seed();
      const task = await stores[0].submit(scope, 'governance-first', input);
      const claim = await stores[0].claim('worker');
      const governor = await p2.connect(), worker = await p1.connect();
      let receipt;
      try {
        await governor.query('BEGIN');
        await govern(scope, 'banned', 0, governor);
        const governorPid = (await governor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const workerPid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await worker.query("SET default_transaction_isolation='repeatable read'");
        const store = new PostgresTaskStore({ connect: async () => ({ query: worker.query.bind(worker), release() {} }) });
        receipt = track(store.finish(claim, 'succeeded'));
        await assertBlocked(owner, workerPid, governorPid, receipt);
        await governor.query('COMMIT');
        assert.equal(await receipt.promise, false);
        assert.equal((await stores[1].get(scope, task.id)).cancelReason, 'account_banned');
      } finally {
        await governor.query('ROLLBACK');
        await receipt?.promise.catch(() => {});
        await worker.query('RESET default_transaction_isolation');
        worker.release(); governor.release();
      }
    });

    await scenario('governance waits for an admitted Worker transaction to commit', async () => {
      const scope = await seed();
      const task = await stores[0].submit(scope, 'worker-first', input);
      const claim = await stores[0].claim('worker');
      const worker = await p1.connect(), governor = await p2.connect();
      const ready = Promise.withResolvers(), gate = Promise.withResolvers();
      let receipt, change;
      try {
        const workerPid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const governorPid = (await governor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        // Pause after a REAL database governance read, while the transaction is open.
        const store = new PostgresTaskStore({ connect: async () => ({
          async query(sql, params) {
            const result = await worker.query(sql, params);
            if (sql.startsWith('SELECT platform_scheduler_account_access')) { ready.resolve(); await gate.promise; }
            return result;
          },
          release() {},
        }) });
        receipt = track(store.finish(claim, 'succeeded'));
        await Promise.race([ready.promise, receipt.promise.then(() => assert.fail('receipt did not read governance'))]);
        change = track(govern(scope, 'banned', 0, governor));
        await assertBlocked(owner, governorPid, workerPid, change);
        gate.resolve();
        assert.equal(await receipt.promise, true);
        await change.promise;
        assert.equal((await stores[1].get(scope, task.id)).status, 'succeeded');
        assert.equal(await stores[1].heartbeat(claim), false);
        await assert.rejects(stores[0].submit(scope, 'after-ban', input), /account_banned/);
      } finally {
        gate.resolve();
        await Promise.allSettled([receipt?.promise, change?.promise]);
        worker.release(); governor.release();
      }
    });
  } finally {
    await Promise.all([p1?.end(), p2?.end(), owner?.end()]);
    try {
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await admin.query('DROP ROLE IF EXISTS ' + role);
    } finally { await admin.end(); }
  }
});
