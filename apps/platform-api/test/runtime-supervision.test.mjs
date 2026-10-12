import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryRuntimeControlStore } from '../src/runtime/control-store.mjs';

async function fixture() {
  let now = Date.now();
  const store = new MemoryRuntimeControlStore({ now: () => now, agents: [{ id: 'a', organizationId: 'org', ownerUserId: 'u', engine: 'pi' }] });
  const start = await store.requestStart({ actorUserId: 'u', agentId: 'a', requestId: randomUUID(), expectedGeneration: 0,
    resourceSpec: { cpuMillis: 200, memoryBytes: 134217728, pidsLimit: 32, idleTtlSeconds: 60 } });
  const [command] = await store.claimCommands('worker', 1);
  await store.commitStarted({ ...command.payload, workerId: 'worker', requestId: command.requestId, leaseAttempt: command.attempts,
    orchestratorRef: 'container', runtimeUrl: 'http://probe:8092' });
  await store.completeCommand({ workerId: 'worker', commandId: command.id, leaseAttempt: command.attempts, status: 'succeeded' });
  return { store, start, advance(ms = 61000) { now += ms; }, now: () => now };
}
const receipt = (observation, now, status = 'running') => ({ ...observation, status, observedAt: new Date(now).toISOString(),
  orchestratorRef: status === 'running' ? 'container' : null, runtimeUrl: status === 'running' ? 'http://probe:8092' : null });

test('observation claim is exclusive; signed terminal state clears route/run and changes desired state without restart', async () => {
  const { store, now, start } = await fixture();
  const claimed = await store.claimObservation('observer');
  assert.equal(await store.claimObservation('other'), null);
  assert.equal(claimed.runId, start.runId);
  assert.equal((await store.recordObservation(receipt(claimed, now(), 'stopped'))).result, 'stopped');
  assert.equal(store.control('a').desiredState, 'stopped');
  assert.equal(store.control('a').activeRunId, null);
  assert.equal(store.control('a').generation, 2);
  assert.equal(store.run(start.runId).status, 'stopped');
  assert.equal(store.route('a'), null);
  assert.equal(await store.claimObservation('observer'), null);
  assert.equal(store.commandsFor('a').length, 1);
});

test('expired or replaced observation leases cannot submit; transport failure never means stopped', async () => {
  const { store, now, advance } = await fixture();
  const first = await store.claimObservation('same');
  advance();
  const second = await store.claimObservation('same');
  assert.notEqual(second.leaseToken, first.leaseToken);
  await assert.rejects(store.recordObservation(receipt(first, now(), 'absent')), /observation_lease_lost/);
  await store.recordObservation(receipt(second, now(), 'error'));
  assert.equal(store.control('a').desiredState, 'running');
  assert.ok(store.control('a').activeRunId);
  assert.equal((await store.supervisionSnapshot()).observationErrors, 1);
  assert.equal((await store.supervisionSnapshot()).observationStale, 1);
  advance(11000);
  await store.recordObservation(receipt(await store.claimObservation('same'), now()));
  assert.equal((await store.supervisionSnapshot()).observationErrors, 0);
  assert.equal((await store.supervisionSnapshot()).observationStale, 0);
});

test('late running observation cannot restore a governance-revoked route', async () => {
  const { store, now } = await fixture();
  const old = await store.claimObservation('observer');
  store.setGovernance('u', 'suspended', 1);
  await store.reconcileGovernance();
  assert.equal(store.route('a'), null);
  await assert.rejects(store.recordObservation(receipt(old, now())), /observation_superseded/);
  assert.equal(store.route('a'), null);
});

test('new run rejects old terminal observation; active dead alerts resolve only on actual terminal confirmation', async () => {
  const { store, now, advance } = await fixture();
  await store.requestStop({ actorUserId: 'u', agentId: 'a', expectedGeneration: 1, requestId: randomUUID(), reason: 'test' });
  const [command] = await store.claimCommands('worker', 1);
  await store.completeCommand({ workerId: 'worker', commandId: command.id, leaseAttempt: command.attempts, status: 'dead' });
  advance();
  assert.equal((await store.supervisionSnapshot()).stopOverdue, 1);
  assert.equal((await store.supervisionSnapshot()).deadPending, 1);
  const old = await store.claimObservation('observer');
  await store.recordObservation(receipt(old, now(), 'absent'));
  assert.equal((await store.supervisionSnapshot()).deadPending, 0);
  const next = await store.requestStart({ actorUserId: 'u', agentId: 'a', expectedGeneration: 2, requestId: randomUUID(),
    resourceSpec: { cpuMillis: 200, memoryBytes: 134217728, pidsLimit: 32, idleTtlSeconds: 60 } });
  assert.notEqual(next.runId, old.runId);
  await assert.rejects(store.recordObservation(receipt(old, now(), 'absent')), /observation_/);
  assert.equal(store.control('a').activeRunId, next.runId);
});

test('running observation cannot change container/location or create missing route', async () => {
  const { store, now, advance } = await fixture();
  const first = await store.claimObservation('observer');
  await assert.rejects(store.recordObservation({ ...receipt(first, now()), orchestratorRef: 'imposter' }), /observation_identity_conflict/);
  await store.recordObservation(receipt(first, now(), 'error'));
  store.routes.clear(); advance(11000);
  await store.recordObservation(receipt(await store.claimObservation('observer'), now()));
  assert.equal(store.route('a'), null);
});

test('governance unavailable leaves the full observation unchanged and replacement generation may claim immediately', async () => {
  const { store, now } = await fixture();
  const claim = await store.claimObservation('observer');
  store.governance.set('u', null);
  await assert.rejects(store.recordObservation(receipt(claim, now(), 'absent')), /governance_unavailable/);
  assert.equal(store.control('a').activeRunId, claim.runId);
  assert.equal(store.route('a').routeVersion, 1);
  store.governance.delete('u');
  await store.recordObservation(receipt(claim, now()));
  await store.requestStop({ actorUserId: 'u', agentId: 'a', expectedGeneration: 1, requestId: randomUUID(), reason: 'test' });
  const next = await store.claimObservation('observer');
  assert.ok(next); assert.equal(next.controlGeneration, 2);
});
