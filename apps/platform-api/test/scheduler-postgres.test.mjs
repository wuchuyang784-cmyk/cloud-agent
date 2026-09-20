import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresTaskStore } from '../src/scheduler/task-store.mjs';
import { executeSimulation } from '../src/scheduler/simulation-worker.mjs';

test('PostgreSQL scheduler: 10 tenants/50 tasks, two replicas, RLS, leases and persistence', {
  skip: !process.env.BAIRUI_SCHEDULER_TEST_DATABASE_URL,
}, async () => {
  const connectionString = process.env.BAIRUI_SCHEDULER_TEST_DATABASE_URL;
  const admin = new Pool({ connectionString });
  const suffix = randomUUID().replaceAll('-', '');
  const schema = 'scheduler_test_' + suffix, role = 'scheduler_role_' + suffix;
  let migration, p1, p2, failure;
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    await admin.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    migration = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    const dir = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) await migration.query(await readFile(new URL(name, dir), 'utf8'));
    for (let i = 0; i < 10; i++) {
      await migration.query('INSERT INTO organizations(id,name) VALUES ($1,$1)', ['o' + i]);
      await migration.query('INSERT INTO users(id,email) VALUES ($1,$2)', ['u' + i, 'simulation' + i + '@example.test']);
      await migration.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES ($1,$2,$3)', ['o' + i, 'u' + i, 'org_admin']);
    }
    await admin.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
    await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ' + schema + ' TO ' + role);
    const options = { connectionString, max: 6, options: '-c search_path=' + schema + ',public -c role=' + role };
    p1 = new Pool(options); p2 = new Pool(options);
    const privilege = (await p1.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(privilege.rolsuper, false); assert.equal(privilege.rolbypassrls, false);
    const stores = [new PostgresTaskStore(p1), new PostgresTaskStore(p2)];
    const scopes = Array.from({ length: 10 }, (_, i) => ({ userId: 'u' + i, organizationId: 'o' + i }));
    const input = { durationMs: 2000, outcome: 'success' };
    const submitted = await Promise.all(scopes.flatMap((scope, i) => Array.from({ length: 5 }, (_, j) => stores[i % 2].submit(scope, 'task-' + j, input))));
    assert.equal(submitted.length, 50);
    assert.equal((await p1.query('SELECT * FROM simulation_tasks')).rowCount, 0);
    assert.equal(await stores[1].get(scopes[1], submitted[0].id), null);
    assert.equal(await stores[1].cancel(scopes[1], submitted[0].id), null);
    assert.equal((await stores[1].submit(scopes[0], 'task-0', input)).id, submitted[0].id);
    await assert.rejects(stores[1].submit(scopes[0], 'task-0', { ...input, durationMs: 3000 }), /idempotency_conflict/);
    let completed = 0;
    for (let batch = 0; batch < 5; batch++) {
      const claimed = (await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].claim('w' + i % 2)))).filter(Boolean);
      assert.equal(claimed.length, 10);
      assert.equal(new Set(claimed.map(t => t.userId)).size, 10);
      for (const worker of ['w0', 'w1']) assert.equal(claimed.filter(t => t.workerId === worker).length, 5);
      const results = await Promise.all(claimed.map((task, i) => executeSimulation(stores[i % 2], task)));
      assert.ok(results.every(Boolean)); completed += results.length;
    }
    assert.equal(completed, 50);
    assert.equal((await new PostgresTaskStore(p2).list(scopes[0])).filter(t => t.status === 'succeeded').length, 5);
    const failure = await stores[0].submit(scopes[0], 'failure', { ...input, outcome: 'failure' });
    await executeSimulation(stores[1], await stores[0].claim('w0'));
    assert.equal((await stores[1].get(scopes[0], failure.id)).status, 'failed');
    const crash = await stores[0].submit(scopes[0], 'crash', input);
    const old = await stores[0].claim('old');
    await migration.query('UPDATE simulation_tasks SET "leaseUntil"=0 WHERE id=$1', [crash.id]);
    const recovered = await stores[1].claim('replacement');
    assert.equal(recovered.id, crash.id); assert.equal(recovered.attempt, 2);
    assert.equal(await stores[0].finish(old, 'succeeded'), false);
    await stores[0].cancel(scopes[0], crash.id);
    assert.equal(await stores[1].heartbeat(recovered), false);
    assert.equal(await stores[1].finish(recovered, 'succeeded'), false);
    const retry = await stores[0].submit(scopes[1], 'retry-limit', input);
    for (let i = 0; i < 3; i++) {
      assert.equal((await stores[i % 2].claim('retry-worker')).id, retry.id);
      await migration.query('UPDATE simulation_tasks SET "leaseUntil"=0 WHERE id=$1', [retry.id]);
    }
    assert.equal(await stores[0].claim('retry-worker'), null);
    assert.equal((await stores[1].get(scopes[1], retry.id)).status, 'failed');
    for (let i = 0; i < 20; i++) await stores[0].submit(scopes[0], 'limit-' + i, input);
    await assert.rejects(stores[1].submit(scopes[0], 'over-limit', input), /queue_full/);
    const singleTenant = (await Promise.all(Array.from({ length: 15 }, (_, i) => stores[i % 2].claim('limit-w' + i % 2)))).filter(Boolean);
    assert.equal(singleTenant.length, 5);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await p1?.end(); await p2?.end(); await migration?.end();
      await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
      await admin.query('DROP ROLE IF EXISTS ' + role);
    } catch (error) {
      if (!failure) throw error;
    } finally {
      await admin.end();
    }
  }
});
