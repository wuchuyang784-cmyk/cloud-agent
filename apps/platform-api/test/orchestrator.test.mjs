import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryOrchestratorLedger } from '../src/runtime/orchestrator/ledger.mjs';
import { Orchestrator } from '../src/runtime/orchestrator/service.mjs';

const spec = () => ({ agentId: 'agent-a', runId: 'run-a', runGeneration: 1, engine: 'pi',
  resourceSpec: { cpuMillis: 200, memoryBytes: 134217728, pidsLimit: 32, idleTtlSeconds: 60 } });
const stop = () => ({ ...spec(), fenceGeneration: 2, reason: 'stop' });
function setup() {
  let now = 1000;
  const ledger = new MemoryOrchestratorLedger();
  const containers = new Map();
  const docker = {
    async find(row) { return containers.get(row.runId) ?? null; },
    async create(row) { const value = { id: 'a'.repeat(64), running: false, runtimeUrl: 'http://probe:8092' }; containers.set(row.runId, value); return value; },
    async start(row) { containers.get(row.runId).running = true; },
    async ready() {},
    async remove(row) { containers.delete(row.runId); },
  };
  const service = new Orchestrator({ ledger, docker, clock: () => now });
  return { service, ledger, docker, containers, advance: () => { now += 61000; } };
}

test('start is idempotent, run identity/spec immutable, stop never resurrects', async () => {
  const { service, containers } = setup();
  assert.equal((await service.start(spec())).status, 'running');
  assert.equal((await service.start(spec())).status, 'running');
  assert.equal(containers.size, 1);
  await assert.rejects(service.start({ ...spec(), agentId: 'other' }), /identity_conflict/);
  await assert.rejects(service.start({ ...spec(), resourceSpec: { ...spec().resourceSpec, cpuMillis: 300 } }), /spec_conflict/);
  assert.equal((await service.stop(stop())).status, 'stopped');
  assert.equal(containers.size, 0);
  await assert.rejects(service.start(spec()), /run_fenced/);
});

test('absent tombstone survives service recreation and rejects delayed PUT', async () => {
  const { service, ledger, docker } = setup();
  assert.equal((await service.stop(stop())).status, 'absent');
  const restarted = new Orchestrator({ ledger, docker });
  await assert.rejects(restarted.start(spec()), /run_fenced/);
  assert.equal((await restarted.inspect('run-a')).status, 'absent');
});

test('unknown create may arrive late: missing container cannot confirm absent or retry create', async () => {
  const { service, docker, containers, ledger } = setup();
  const create = docker.create;
  docker.create = async () => { throw new Error('docker_unknown'); };
  await assert.rejects(service.start(spec()), /docker_unknown/);
  await assert.rejects(service.start(spec()), /creation_uncertain/);
  await assert.rejects(service.stop(stop()), /creation_uncertain/);
  assert.equal((await ledger.read('run-a')).phase, 'stopping');
  await create(spec()); // daemon's late completion, not another service create
  assert.equal((await service.stop(stop())).status, 'stopped');
  assert.equal(containers.size, 0);
  await assert.rejects(service.start(spec()), /run_fenced/);
});

test('failed removal and failed observation never report resource release; retry recovers', async () => {
  const { service, docker, ledger } = setup();
  await service.start(spec());
  const remove = docker.remove;
  docker.remove = async () => { throw new Error('docker_unavailable'); };
  await assert.rejects(service.stop(stop()), /docker_unavailable/);
  assert.equal((await ledger.read('run-a')).phase, 'stopping');
  docker.remove = remove;
  assert.equal((await service.stop(stop())).status, 'stopped');
  docker.find = async () => { throw new Error('docker_unavailable'); };
  await assert.rejects(service.inspect('run-a'), /docker_unavailable/);
});

test('TTL starts once; GET and retry cannot renew it; reaper deletes real workload through driver', async () => {
  const { service, containers, advance } = setup();
  await service.start(spec());
  await service.inspect('run-a');
  await service.start(spec());
  advance();
  const result = await service.reap();
  assert.equal(result.reclaimed, 1);
  assert.equal(containers.size, 0);
  assert.equal((await service.inspect('run-a')).status, 'stopped');
  await assert.rejects(service.start(spec()), /run_fenced/);
});

test('concurrent stop/start serialized and terminal intent wins', async () => {
  const { service, containers } = setup();
  const results = await Promise.allSettled([service.stop(stop()), service.start(spec())]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(containers.size, 0);
});

test('unexpected container exit reclaims without restart; unknown run GET is not absence', async () => {
  const { service, containers } = setup();
  await assert.rejects(service.inspect('missing'), /run_not_found/);
  await service.start(spec());
  containers.get('run-a').running = false;
  assert.equal((await service.inspect('run-a')).status, 'stopped');
  assert.equal(containers.size, 0);
});

test('durable intent failure prevents Docker side effect and unsupported engine rejected', async () => {
  const { service, ledger, containers } = setup();
  await assert.rejects(service.start({ ...spec(), engine: 'dsh' }), /engine_unsupported/);
  ledger.withRun = async () => { throw new Error('ledger_unavailable'); };
  await assert.rejects(service.start(spec()), /ledger_unavailable/);
  assert.equal(containers.size, 0);
});

test('start side effect followed by unknown result never restarts an exited old process', async () => {
  const { service, docker, containers } = setup();
  let starts = 0;
  docker.start = async row => { starts++; containers.get(row.runId).running = true; throw new Error('start_unknown'); };
  await assert.rejects(service.start(spec()), /start_unknown/);
  containers.get('run-a').running = false;
  await assert.rejects(service.start(spec()), /run_fenced/);
  assert.equal(starts, 1);
  assert.equal(containers.size, 0);
});

test('JSONB field order does not change request identity', async () => {
  const { service, ledger } = setup();
  await service.start(spec());
  await ledger.withRun('run-a', async tx => {
    const row = await tx.read();
    row.request = { resourceSpec: row.request.resourceSpec, engine: 'pi', runGeneration: 1, runId: 'run-a', agentId: 'agent-a' };
    await tx.save(row);
  });
  assert.equal((await service.start(spec())).status, 'running');
});

test('failed observations rotate so reaper cannot starve later expired runs', async () => {
  const { service, docker, advance, ledger } = setup();
  await service.start(spec());
  await service.start({ ...spec(), runId: 'run-b' });
  const find = docker.find;
  docker.find = async row => { if (row.runId === 'run-a') throw new Error('docker_unknown'); return find(row); };
  advance();
  assert.equal((await service.reap(1)).failed, 1);
  assert.equal((await service.reap(1)).reclaimed, 1);
  assert.equal((await ledger.read('run-b')).phase, 'stopped');
});

test('unknown start recovery must recheck readiness without repeating Docker start', async () => {
  const { service, docker } = setup();
  let healthy = false; let starts = 0;
  const start = docker.start;
  docker.start = async row => { starts++; await start(row); };
  docker.ready = async () => { if (!healthy) throw new Error('runtime_not_ready'); };
  await assert.rejects(service.start(spec()), /runtime_not_ready/);
  await assert.rejects(service.start(spec()), /runtime_not_ready/);
  healthy = true;
  assert.equal((await service.start(spec())).status, 'running');
  assert.equal(starts, 1);
});

test('TTL reclaims owned containers despite runtime policy drift, but preserves ownership checks', async () => {
  const { service, docker, advance, containers } = setup();
  await service.start(spec());
  const find = docker.find;
  docker.find = async row => { if (!row.terminal) throw new Error('docker_policy_mismatch'); return find(row); };
  advance();
  assert.equal((await service.reap()).reclaimed, 1);
  assert.equal(containers.size, 0);
});
