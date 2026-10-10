import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { MemoryRuntimeControlStore } from '../src/runtime/control-store.mjs';
import { createSupervisionCoordinator } from '../src/runtime/supervision/coordinator.mjs';
import { startControllerLoop } from '../src/runtime/supervision/loop.mjs';
import { readControllerConfig } from '../src/runtime/supervision/config.mjs';

const resources = { cpuMillis: 200, memoryBytes: 134217728, pidsLimit: 32, idleTtlSeconds: 60 };
test('coordinator handles E1 start, records query failure without releasing, then accepts terminal inspection', async () => {
  let now = Date.now(), status = 'running';
  const store = new MemoryRuntimeControlStore({ now: () => now, agents: [{ id: 'a', ownerUserId: 'u', organizationId: 'org', engine: 'pi' }] });
  await store.requestStart({ actorUserId: 'u', agentId: 'a', expectedGeneration: 0, requestId: randomUUID(), resourceSpec: resources });
  const driver = { stop: async () => { throw new Error('unexpected_stop'); }, provision: async () => ({ orchestratorRef: 'container', runtimeUrl: 'http://probe:8092' }), inspect: async () => {
    if (status === 'error') throw new Error('private HTTP/secret detail');
    return { status, observedAt: new Date(now).toISOString(), orchestratorRef: 'container', runtimeUrl: 'http://probe:8092' };
  } };
  const cycle = createSupervisionCoordinator({ store, driver, workerId: 'worker', now: () => now });
  assert.equal((await cycle()).active, 1);
  now += 11000; status = 'error';
  const failed = await cycle(); assert.equal(failed.observationErrors, 1); assert.equal(failed.active, 1);
  now += 11000; status = 'stopped';
  assert.equal((await cycle()).active, 0); assert.equal(store.route('a'), null);
});

test('periodic loop serializes cycles, reports failure and recovery; shutdown drains without another claim', async () => {
  const results = []; let active = 0, calls = 0, max = 0, release;
  let second;
  const secondStarted = new Promise(resolve => { second = resolve; });
  const loop = startControllerLoop({ intervalMs: 5, telemetry: { update: value => results.push(value) }, cycle: async continuing => {
    calls++; active++; max = Math.max(max, active);
    try {
      if (calls === 1) throw new Error('private database detail');
      second(); await new Promise(resolve => { release = resolve; });
      assert.equal(continuing(), false); return { active: 1 };
    } finally { active--; }
  } });
  await secondStarted;
  const closing = loop.close();
  release(); await closing; await loop.close();
  assert.equal(max, 1); assert.equal(calls, 2);
  assert.equal(results[0].ok, false); assert.equal(results[1].ok, true);
});

test('shutdown predicate prevents further E1 or observation claims', async () => {
  const store = new MemoryRuntimeControlStore({ agents: [{ id: 'a', ownerUserId: 'u', organizationId: 'org', engine: 'pi' }] });
  await store.requestStart({ actorUserId: 'u', agentId: 'a', expectedGeneration: 0, requestId: randomUUID(), resourceSpec: resources });
  const cycle = createSupervisionCoordinator({ store, driver: { provision() {}, stop() {}, inspect() {} }, workerId: 'worker' });
  await cycle(() => false);
  assert.equal(store.commandsFor('a')[0].attempts, 0);
  assert.equal(store.control('a').observation, undefined);
});

test('controller config requires isolation, separate database, HTTPS and explicit fixed address allowlist', () => {
  assert.throws(() => readControllerConfig({}), /isolation_mode_required/);
  const env = { BAIRUI_RUNTIME_CONTROLLER_MODE: 'isolation', BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL: 'postgresql://controller:pass@127.0.0.1:5432/e3_check',
    BAIRUI_RUNTIME_ORCHESTRATOR_URL: 'https://127.0.0.1:9494', BAIRUI_RUNTIME_CONTROL_KEY_ID: 'primary',
    BAIRUI_RUNTIME_CONTROL_SECRET: randomBytes(32).toString('hex'), BAIRUI_RUNTIME_ALLOWED_HOSTS: 'probe',
    BAIRUI_RUNTIME_CONTROLLER_METRICS_TOKEN_FILE: 'controller-token' };
  const config = readControllerConfig(env); assert.equal(config.host, '127.0.0.1'); assert.equal(config.batchSize, 1);
  for (const name of ['bairui', 'bairui_preprod']) assert.throws(() => readControllerConfig({ ...env,
    BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL: `postgresql://controller:pass@127.0.0.1:5432/${name}` }), /config_invalid/);
  assert.throws(() => readControllerConfig({ ...env, BAIRUI_RUNTIME_ORCHESTRATOR_URL: 'http://127.0.0.1:9494' }), /config_invalid/);
  assert.throws(() => readControllerConfig({ ...env, BAIRUI_RUNTIME_ALLOWED_HOSTS: '' }), /config_invalid/);
  for (const secret of ['x'.repeat(4097), 'private\n'.repeat(8)]) assert.throws(() => readControllerConfig({ ...env,
    BAIRUI_RUNTIME_CONTROL_SECRET: secret }), /config_invalid/);
  for (const range of ['0.0.0.0/0', '::/0', 'uniquelocal']) assert.throws(() => readControllerConfig({ ...env,
    BAIRUI_RUNTIME_ALLOWED_CIDRS: range }), /config_invalid/);
  for (const query of ['host=192.0.2.15', 'database=bairui', 'dbname=bairui', 'user=postgres', 'port=5433',
    'options=-c%20role=postgres', 'options=-c%20search_path=public&options=-c%20role=postgres']) {
    assert.throws(() => readControllerConfig({ ...env, BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL:
      env.BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL + '?' + query }), /config_invalid/);
  }
  assert.ok(readControllerConfig({ ...env, BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL:
    env.BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL + '?options=-c%20search_path=runtime_check,public' }));
});
