import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { MemoryRuntimeControlStore, RuntimeControlError } from '../src/runtime/control-store.mjs';

const resourceSpec = Object.freeze({
  cpuMillis: 500,
  memoryBytes: 536870912,
  pidsLimit: 64,
  idleTtlSeconds: 900,
});

const ids = Object.freeze({
  start1: '00000000-0000-4000-8000-000000000001',
  stop1: '00000000-0000-4000-8000-000000000002',
  start2: '00000000-0000-4000-8000-000000000003',
  other: '00000000-0000-4000-8000-000000000004',
});

function createStore(options = {}) {
  let sequence = 0;
  let now = Date.parse('2026-10-08T00:00:00.000Z');
  const store = new MemoryRuntimeControlStore({
    agents: [{
      id: 'agent-1',
      organizationId: 'org-1',
      ownerUserId: 'user-1',
      engine: 'pi',
      templateVersion: 1,
      subdomain: 'agent-agent-1.example.test',
    }],
    governance: [{ userId: 'user-1', status: 'active', version: 0 }],
    idFactory: () => `generated-${++sequence}`,
    now: () => now,
    ...options,
  });
  return { store, advance: (milliseconds) => { now += milliseconds; } };
}

async function start(store, overrides = {}) {
  return store.requestStart({
    actorUserId: 'user-1',
    agentId: 'agent-1',
    requestId: ids.start1,
    expectedGeneration: 0,
    resourceSpec,
    ...overrides,
  });
}

async function commitStart(store, result, overrides = {}) {
  const pending = store.commandsFor('agent-1').find(row => row.requestId === result.commandRequestId);
  if (pending.status === 'queued') await store.claimCommands('controller-1', 10);
  const command = store.commandsFor('agent-1').find(row => row.requestId === result.commandRequestId);
  return store.commitStarted({
    workerId: 'controller-1',
    requestId: result.commandRequestId,
    agentId: 'agent-1',
    runId: result.runId,
    runGeneration: result.generation,
    orchestratorRef: `ref-${result.runId}`,
    runtimeUrl: `http://${result.runId}.runtime.internal:8092`,
    leaseAttempt: command.attempts,
    ...overrides,
  });
}

test('memory runtime control: start creates one fenced run and one runtime command', async () => {
  const { store } = createStore();
  const result = await start(store);
  assert.deepEqual(result, {
    result: 'accepted', generation: 1, runId: 'generated-1', replayed: false, commandRequestId: ids.start1,
  });
  assert.deepEqual(store.control('agent-1'), {
    agentId: 'agent-1', organizationId: 'org-1', ownerUserId: 'user-1', desiredState: 'running',
    generation: 1, activeRunId: 'generated-1', governanceVersion: 0, resourceSpec, lastRequestId: ids.start1,
    changedBy: 'user-1', changeReason: 'start', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
  });
  assert.equal(store.run(result.runId).status, 'initializing');
  const [command] = await store.claimCommands('controller-1', 10);
  assert.equal(command.eventType, 'runtime.start.requested');
  assert.deepEqual(command.payload, {
    agentId: 'agent-1', runId: 'generated-1', runGeneration: 1, engine: 'pi', resourceSpec,
  });
  assert.equal(command.attempts, 1);
});

test('memory runtime control: request replay is stable and conflicting reuse is rejected', async () => {
  const { store } = createStore();
  const first = await start(store);
  assert.deepEqual(await start(store), { ...first, replayed: true });
  await assert.rejects(
    () => start(store, { resourceSpec: { ...resourceSpec, cpuMillis: 600 } }),
    (error) => error instanceof RuntimeControlError && error.code === 'idempotency_conflict',
  );
  assert.equal(store.commandsFor('agent-1').length, 1);
});

test('memory runtime control: a different start while already desired running is a same-generation noop', async () => {
  const { store } = createStore();
  const first = await start(store);
  const noop = await start(store, { requestId: ids.other, expectedGeneration: 1 });
  assert.deepEqual(noop, {
    result: 'noop', generation: 1, runId: first.runId, replayed: false, commandRequestId: null,
  });
  assert.equal(store.commandsFor('agent-1').length, 1);
});

test('memory runtime control: stop removes the route before external confirmation and remains stopping', async () => {
  const { store } = createStore();
  const started = await start(store);
  assert.equal((await commitStart(store, started)).result, 'committed');
  assert.equal(store.route('agent-1').routeVersion, 1);

  const stopped = await store.requestStop({
    actorUserId: 'user-1', agentId: 'agent-1', requestId: ids.stop1,
    expectedGeneration: 1, reason: ' manual stop ',
  });
  assert.deepEqual(stopped, {
    result: 'accepted', generation: 2, runId: started.runId, replayed: false, commandRequestId: ids.stop1,
  });
  assert.equal(store.route('agent-1'), null);
  assert.equal(store.run(started.runId).status, 'stopping');
  assert.equal(store.control('agent-1').activeRunId, started.runId);
  assert.equal(store.commandsFor('agent-1').filter((row) => row.eventType === 'runtime.stop.requested').length, 1);
});

test('memory runtime control: a late start success cannot restore a stopped generation', async () => {
  const { store } = createStore();
  const started = await start(store);
  await store.requestStop({
    actorUserId: 'user-1', agentId: 'agent-1', requestId: ids.stop1,
    expectedGeneration: 1, reason: 'stop during start',
  });
  const stale = await commitStart(store, started);
  assert.equal(stale.result, 'stale_stop_enqueued');
  assert.equal(store.route('agent-1'), null);
  assert.equal(store.run(started.runId).status, 'stopping');
  assert.equal(store.commandsFor('agent-1').filter((row) => row.eventType === 'runtime.stop.requested').length, 1);
});

test('memory runtime control: only a confirmed stop clears the matching active run', async () => {
  const { store } = createStore();
  const first = await start(store);
  await commitStart(store, first);
  const stop = await store.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: ids.stop1, expectedGeneration: 1, reason: 'rotate' });
  assert.equal(store.control('agent-1').activeRunId, first.runId);
  await store.claimCommands('controller-1', 10);
  await store.commitStopped({
    workerId: 'controller-1', requestId: stop.commandRequestId, agentId: 'agent-1', runId: first.runId,
    runGeneration: 1, fenceGeneration: 2, status: 'stopped', confirmedAt: '2026-10-08T00:00:01.000Z',
    leaseAttempt: 1,
  });
  assert.equal(store.control('agent-1').activeRunId, null);
  const second = await start(store, { requestId: ids.start2, expectedGeneration: 2 });
  await commitStart(store, second);
  assert.equal(store.control('agent-1').activeRunId, second.runId);
  await store.commitStopped({
    workerId: 'controller-1', requestId: stop.commandRequestId, agentId: 'agent-1', runId: first.runId,
    runGeneration: 1, fenceGeneration: 2, status: 'absent', confirmedAt: '2026-10-08T00:00:02.000Z',
    leaseAttempt: 1,
  });
  assert.equal(store.control('agent-1').activeRunId, second.runId);
  assert.equal(store.route('agent-1').runId, second.runId);
});

test('memory runtime control: a new start waits for an unconfirmed old stop', async () => {
  const { store } = createStore();
  const first = await start(store);
  await store.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: ids.stop1, expectedGeneration: 1, reason: 'stop' });
  await assert.rejects(
    () => start(store, { requestId: ids.start2, expectedGeneration: 2 }),
    (error) => error instanceof RuntimeControlError && error.code === 'runtime_stop_pending',
  );
  assert.equal(store.control('agent-1').activeRunId, first.runId);
});

test('memory runtime control: suspended and banned owners are stopped but reactivation never restarts', async () => {
  const { store } = createStore();
  const started = await start(store);
  await commitStart(store, started);
  store.setGovernance('user-1', 'suspended', 1);
  assert.deepEqual(await store.reconcileGovernance({ workerId: 'controller-1', limit: 10 }), { stopped: 1, started: 0 });
  assert.equal(store.control('agent-1').desiredState, 'stopped');
  assert.equal(store.route('agent-1'), null);
  assert.equal((await store.reconcileGovernance({ workerId: 'controller-1', limit: 10 })).stopped, 0);
  store.setGovernance('user-1', 'active', 2);
  assert.deepEqual(await store.reconcileGovernance({ workerId: 'controller-1', limit: 10 }), { stopped: 0, started: 0 });
  assert.equal(store.control('agent-1').desiredState, 'stopped');

  const { store: banned } = createStore({ governance: [{ userId: 'user-1', status: 'banned', version: 1 }] });
  await assert.rejects(
    () => start(banned),
    (error) => error instanceof RuntimeControlError && error.code === 'account_runtime_forbidden',
  );
});

test('memory runtime control: leases recover and completion requires the owning worker', async () => {
  const { store, advance } = createStore();
  await start(store);
  const [leased] = await store.claimCommands('controller-1', 10);
  assert.equal((await store.claimCommands('controller-2', 10)).length, 0);
  assert.equal(await store.completeCommand({ workerId: 'controller-2', commandId: leased.id, status: 'succeeded' }), false);
  advance(60_001);
  const [recovered] = await store.claimCommands('controller-2', 10);
  assert.equal(recovered.id, leased.id);
  assert.equal(recovered.attempts, 2);
  assert.equal(await store.completeCommand({ workerId: 'controller-2', commandId: leased.id, leaseAttempt: recovered.attempts, status: 'succeeded' }), true);
  assert.equal(store.commandsFor('agent-1')[0].status, 'succeeded');
});

test('memory runtime control: pause then restore before reconcile fences the original run', async () => {
  const { store } = createStore();
  const first = await start(store);
  await commitStart(store, first);
  store.setGovernance('user-1', 'suspended', 1);
  store.setGovernance('user-1', 'active', 2);
  assert.equal((await store.reconcileGovernance({ limit: 10 })).stopped, 1);
  assert.equal(store.route('agent-1'), null);
  assert.equal(store.control('agent-1').desiredState, 'stopped');
});

test('memory governance commands cannot collide with a caller-chosen start request UUID', async () => {
  const { store } = createStore();
  const hex = createHash('sha256').update('user-1\n1\nagent-1').digest('hex').slice(0, 32).split('');
  hex[12] = '5'; hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  const requestId = `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
  const first = await start(store, { requestId });
  await commitStart(store, first);
  store.setGovernance('user-1', 'banned', 1);
  assert.equal((await store.reconcileGovernance({ limit: 10 })).stopped, 1);
  assert.equal(store.route('agent-1'), null);
  const stop = store.commandsFor('agent-1').find(row => row.eventType === 'runtime.stop.requested');
  assert.ok(stop);
  assert.notEqual(stop.requestId, requestId);
  assert.equal((await store.reconcileGovernance({ limit: 10 })).stopped, 0);
});

test('memory runtime control: expired receipt and same-worker recovered lease cannot mutate state', async () => {
  const { store, advance } = createStore();
  const first = await start(store);
  const [command] = await store.claimCommands('controller-1', 10);
  advance(60_001);
  await store.claimCommands('controller-1', 10);
  const input = { workerId: 'controller-1', requestId: command.requestId, agentId: 'agent-1', runId: first.runId,
    runGeneration: 1, orchestratorRef: 'ref', runtimeUrl: 'http://runtime.internal:8092', leaseAttempt: 1 };
  await assert.rejects(() => store.commitStarted(input), { code: 'runtime_command_lease_lost' });
  assert.equal(await store.completeCommand({ workerId: 'controller-1', commandId: command.id, leaseAttempt: 1, status: 'succeeded' }), false);
  assert.equal(store.route('agent-1'), null);
});

test('memory runtime control: stale queued start is skipped before an external side effect', async () => {
  const { store } = createStore();
  await start(store);
  await store.requestStop({ actorUserId: 'user-1', agentId: 'agent-1', requestId: ids.stop1, expectedGeneration: 1, reason: 'stop' });
  const commands = await store.claimCommands('controller-1', 10);
  const command = commands.find(row => row.eventType === 'runtime.start.requested');
  assert.deepEqual(await store.prepareCommand({ workerId: 'controller-1', requestId: command.requestId, leaseAttempt: command.attempts }), { eligible: false, reason: 'superseded' });
});
