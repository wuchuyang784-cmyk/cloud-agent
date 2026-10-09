import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRuntimeControlStore } from '../src/runtime/control-store.mjs';
import { RuntimeController, safeRuntimeErrorCode } from '../src/runtime/controller.mjs';
import { RemoteRuntimeDriver } from '../src/runtime/orchestration/remote-driver.mjs';
import { FakeRuntimeOrchestrator } from './helpers/fake-runtime-orchestrator.mjs';

const secret = 'runtime-controller-test-secret-at-least-32-characters';
const resourceSpec = Object.freeze({ cpuMillis: 500, memoryBytes: 536870912, pidsLimit: 64, idleTtlSeconds: 900 });

test('controller error persistence only accepts known enum codes', () => {
  assert.equal(safeRuntimeErrorCode({ code: 'secret-that-looks-like-a-code' }), 'runtime_control_error');
  assert.equal(safeRuntimeErrorCode({ code: 'stop_not_confirmed' }), 'stop_not_confirmed');
});

function createStore() {
  let id = 0;
  let now = Date.parse('2026-10-08T00:00:00.000Z');
  return {
    store: new MemoryRuntimeControlStore({
      agents: [{ id: 'agent-1', organizationId: 'org-1', ownerUserId: 'user-1', engine: 'pi', templateVersion: 1 }],
      governance: [{ userId: 'user-1', status: 'active', version: 0 }],
      idFactory: () => `generated-${++id}`,
      now: () => now,
    }),
    advance: (milliseconds) => { now += milliseconds; },
  };
}

async function fixture(t, options = {}) {
  const orchestrator = new FakeRuntimeOrchestrator({ secret });
  const origin = await orchestrator.listen();
  t.after(() => orchestrator.close());
  const { store, advance } = createStore();
  const driver = new RemoteRuntimeDriver({
    env: { NODE_ENV: 'test' },
    orchestratorUrl: origin,
    orchestratorKeyId: 'primary',
    orchestratorSecret: secret,
    allowedRuntimeHosts: ['agent-1.runtime.internal'],
    allowInsecureHttp: true,
  });
  const controller = new RuntimeController({ store, driver, workerId: 'controller-1', batchSize: options.batchSize ?? 10, maxAttempts: options.maxAttempts ?? 3 });
  return { orchestrator, store, advance, controller, driver };
}

async function requestStart(store, requestId = '00000000-0000-4000-8000-000000000101', expectedGeneration = 0) {
  return store.requestStart({ actorUserId: 'user-1', agentId: 'agent-1', requestId, expectedGeneration, resourceSpec });
}

test('runtime controller: successful start commits a fenced route and completes the command', async (t) => {
  const { orchestrator, store, controller } = await fixture(t);
  const started = await requestStart(store);
  assert.deepEqual(await controller.tick(), { reconciled: 0, claimed: 1, succeeded: 1, retried: 0, dead: 0 });
  assert.equal(store.route('agent-1').routeVersion, 1);
  assert.equal(store.route('agent-1').runId, started.runId);
  assert.equal(store.run(started.runId).status, 'running');
  assert.equal(store.commandsFor('agent-1')[0].status, 'succeeded');
  assert.equal(orchestrator.run(started.runId).status, 'running');
});

test('runtime controller: stop failure keeps stopping and retries until confirmation', async (t) => {
  const { orchestrator, store, advance, controller } = await fixture(t);
  const started = await requestStart(store);
  await controller.tick();
  await store.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: '00000000-0000-4000-8000-000000000102', expectedGeneration: 1, reason: 'manual stop' });
  orchestrator.failNext('POST', 503);
  assert.equal((await controller.tick()).retried, 1);
  assert.equal(store.route('agent-1'), null);
  assert.equal(store.run(started.runId).status, 'stopping');
  assert.equal(store.control('agent-1').activeRunId, started.runId);
  advance(1_000);
  assert.equal((await controller.tick()).succeeded, 1);
  assert.equal(store.run(started.runId).status, 'stopped');
  assert.equal(store.control('agent-1').activeRunId, null);
});

test('runtime controller: unknown start and stop results reconcile through inspect', async (t) => {
  const { orchestrator, store, controller } = await fixture(t);
  const started = await requestStart(store);
  orchestrator.dropNext('PUT');
  assert.equal((await controller.tick()).succeeded, 1);
  assert.equal(store.route('agent-1').runId, started.runId);

  await store.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: '00000000-0000-4000-8000-000000000103', expectedGeneration: 1, reason: 'unknown stop' });
  orchestrator.dropNext('POST');
  assert.equal((await controller.tick()).succeeded, 1);
  assert.equal(store.run(started.runId).status, 'stopped');
  assert.equal(store.control('agent-1').activeRunId, null);
});

test('runtime controller: stop superseding a queued start never publishes the stale route', async (t) => {
  const { store, controller } = await fixture(t);
  const started = await requestStart(store);
  await store.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: '00000000-0000-4000-8000-000000000104', expectedGeneration: 1, reason: 'race stop' });
  const summary = await controller.tick();
  assert.equal(summary.claimed, 2);
  assert.equal(store.route('agent-1'), null);
  assert.equal(store.run(started.runId).status, 'stopped');
  assert.equal(store.control('agent-1').activeRunId, null);
});

test('runtime controller: stop tombstone rejects an already in-flight delayed PUT', async (t) => {
  const { orchestrator, store, controller, driver } = await fixture(t, { batchSize: 1 });
  const started = await requestStart(store);
  const held = orchestrator.holdNext('PUT');
  t.after(() => held.release());
  const inFlight = controller.tick();
  await held.arrived;
  try {
    await store.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: '00000000-0000-4000-8000-000000000106', expectedGeneration: 1, reason: 'race stop' });
    const second = new RuntimeController({ store, driver, workerId: 'controller-2', batchSize: 1 });
    assert.equal((await second.tick()).succeeded, 1);
  } finally { held.release(); }
  await inFlight;
  assert.notEqual(orchestrator.run(started.runId)?.status, 'running');
  assert.equal(store.run(started.runId).status, 'stopped');
  assert.equal(store.route('agent-1'), null);
});

test('runtime controller: unknown exhausted START atomically fences and queues cleanup', async (t) => {
  const { orchestrator, store, controller } = await fixture(t, { maxAttempts: 1, batchSize: 1 });
  const started = await requestStart(store);
  orchestrator.dropNext('PUT');
  orchestrator.failNext('GET');
  assert.equal((await controller.tick()).dead, 1);
  assert.equal(orchestrator.run(started.runId).status, 'running');
  assert.equal(store.control('agent-1').desiredState, 'stopped');
  assert.equal(store.control('agent-1').generation, 2);
  assert.equal(store.run(started.runId).status, 'stopping');
  assert.equal(store.commandsFor('agent-1').filter(row => row.eventType === 'runtime.stop.requested').length, 1);
  await controller.tick();
  assert.equal(orchestrator.run(started.runId).status, 'stopped');
  assert.equal(store.control('agent-1').activeRunId, null);
});

test('runtime controller: exhausted stop retries become dead without claiming stopped', async (t) => {
  const { orchestrator, store, advance, controller } = await fixture(t, { maxAttempts: 3 });
  const started = await requestStart(store);
  await controller.tick();
  await store.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: '00000000-0000-4000-8000-000000000105', expectedGeneration: 1, reason: 'persistent failure' });
  orchestrator.failEveryStop(503);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await controller.tick();
    advance(31_000);
  }
  const stopCommand = store.commandsFor('agent-1').find((row) => row.eventType === 'runtime.stop.requested');
  assert.equal(stopCommand.status, 'dead');
  assert.equal(stopCommand.lastError, 'stop_not_confirmed');
  assert.equal(store.run(started.runId).status, 'stopping');
  assert.equal(store.control('agent-1').activeRunId, started.runId);
  assert.equal(store.route('agent-1'), null);
});
