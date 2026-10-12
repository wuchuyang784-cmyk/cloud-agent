import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildStartRequest,
  buildStopRequest,
  normalizeResourceSpec,
  parseInspection,
  parseStartConfirmation,
  parseStopConfirmation,
} from '../src/runtime/control-contract.mjs';

const resourceSpec = Object.freeze({
  cpuMillis: 500,
  memoryBytes: 536870912,
  pidsLimit: 64,
  idleTtlSeconds: 900,
});

const identity = Object.freeze({
  agentId: 'agent-1',
  runId: 'run-1',
  runGeneration: 3,
});

test('runtime control contract: resource spec accepts only four bounded integers', () => {
  assert.deepEqual(normalizeResourceSpec(resourceSpec), resourceSpec);
  for (const invalid of [
    null,
    { ...resourceSpec, cpuMillis: 99 },
    { ...resourceSpec, cpuMillis: 8001 },
    { ...resourceSpec, memoryBytes: 134217727 },
    { ...resourceSpec, memoryBytes: 17179869185 },
    { ...resourceSpec, pidsLimit: 15 },
    { ...resourceSpec, pidsLimit: 1025 },
    { ...resourceSpec, idleTtlSeconds: 59 },
    { ...resourceSpec, idleTtlSeconds: 86401 },
    { ...resourceSpec, cpuMillis: 500.5 },
    { ...resourceSpec, env: {} },
  ]) assert.throws(() => normalizeResourceSpec(invalid), { message: 'resource_spec_invalid' });
});

test('runtime control contract: start request is fixed and rejects unsupported engines or identities', () => {
  assert.deepEqual(buildStartRequest({ ...identity, engine: 'pi', resourceSpec, ignored: 'not-forwarded' }), {
    ...identity,
    engine: 'pi',
    resourceSpec,
  });
  assert.equal(buildStartRequest({ ...identity, engine: 'dsh', resourceSpec }).engine, 'dsh');
  assert.throws(() => buildStartRequest({ ...identity, engine: 'mock', resourceSpec }), { message: 'runtime_engine_invalid' });
  assert.throws(() => buildStartRequest({ ...identity, runGeneration: 0, engine: 'pi', resourceSpec }), { message: 'runtime_identity_invalid' });
  assert.throws(() => buildStartRequest({ ...identity, runId: '', engine: 'pi', resourceSpec }), { message: 'runtime_identity_invalid' });
});

test('runtime control contract: stop request has a newer fence and a bounded clean reason', () => {
  assert.deepEqual(buildStopRequest({ ...identity, fenceGeneration: 4, reason: ' governance stop ' }), {
    ...identity,
    fenceGeneration: 4,
    reason: 'governance stop',
  });
  assert.throws(() => buildStopRequest({ ...identity, fenceGeneration: 3, reason: 'stop' }), { message: 'runtime_fence_invalid' });
  assert.throws(() => buildStopRequest({ ...identity, fenceGeneration: 4, reason: '   ' }), { message: 'runtime_reason_invalid' });
  assert.throws(() => buildStopRequest({ ...identity, fenceGeneration: 4, reason: 'bad\nreason' }), { message: 'runtime_reason_invalid' });
  assert.throws(() => buildStopRequest({ ...identity, fenceGeneration: 4, reason: 'x'.repeat(501) }), { message: 'runtime_reason_invalid' });
});

test('runtime control contract: start confirmation requires exact identity and a complete running result', () => {
  const response = {
    ...identity,
    status: 'running',
    orchestratorRef: 'runtime-ref-1',
    runtimeUrl: 'http://agent-1.runtime.internal:8092',
    observedAt: '2026-10-08T00:00:00.000Z',
  };
  assert.deepEqual(parseStartConfirmation(response, identity), response);
  assert.deepEqual(parseStartConfirmation({ ...response, workerId: 'forged', requestId: 'forged', leaseAttempt: 999 }, identity), response);
  assert.throws(() => parseStartConfirmation({ ...response, agentId: 'agent-2' }, identity), { message: 'orchestrator_identity_mismatch' });
  assert.throws(() => parseStartConfirmation({ ...response, status: 'starting' }, identity), { message: 'orchestrator_bad_response' });
  assert.throws(() => parseStartConfirmation({ ...response, orchestratorRef: '' }, identity), { message: 'orchestrator_bad_response' });
  assert.throws(() => parseStartConfirmation({ ...response, observedAt: 'not-a-date' }, identity), { message: 'orchestrator_bad_response' });
});

test('runtime control contract: stop accepts only matching stopped or absent confirmations', () => {
  for (const status of ['stopped', 'absent']) {
    const response = { ...identity, status, confirmedAt: '2026-10-08T00:00:00.000Z' };
    assert.deepEqual(parseStopConfirmation(response, identity), response);
    assert.deepEqual(parseStopConfirmation({ ...response, fenceGeneration: 999 }, identity), response);
  }
  assert.throws(() => parseStopConfirmation({ ...identity, runGeneration: 2, status: 'stopped', confirmedAt: '2026-10-08T00:00:00.000Z' }, identity), { message: 'orchestrator_identity_mismatch' });
  assert.throws(() => parseStopConfirmation({ ...identity, status: 'running', confirmedAt: '2026-10-08T00:00:00.000Z' }, identity), { message: 'orchestrator_bad_response' });
  assert.throws(() => parseStopConfirmation({ ...identity, status: 'absent' }, identity), { message: 'orchestrator_bad_response' });
});

test('runtime control contract: inspection is fenced and running observations carry routable data', () => {
  const running = {
    ...identity,
    status: 'running',
    orchestratorRef: 'runtime-ref-1',
    runtimeUrl: 'http://agent-1.runtime.internal:8092',
    observedAt: '2026-10-08T00:00:00.000Z',
  };
  assert.deepEqual(parseInspection(running, identity), running);
  assert.deepEqual(parseInspection({ ...running, workerId: 'forged', fenceGeneration: 999 }, identity), running);
  const stopping = { ...identity, status: 'stopping', observedAt: '2026-10-08T00:00:00.000Z' };
  assert.deepEqual(parseInspection(stopping, identity), stopping);
  assert.throws(() => parseInspection({ ...stopping, status: 'unknown' }, identity), { message: 'orchestrator_bad_response' });
  assert.throws(() => parseInspection({ ...running, runtimeUrl: '' }, identity), { message: 'orchestrator_bad_response' });
});

test('runtime control acceptance runner is isolated from project credentials', async () => {
  const root = new URL('../../../', import.meta.url);
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const runner = await readFile(new URL('scripts/test-runtime-control.mjs', root), 'utf8');
  assert.equal(packageJson.scripts['test:runtime-control'], 'node scripts/test-runtime-control.mjs');
  assert.doesNotMatch(runner, /--env-file/);
  assert.match(runner, /BAIRUI_RUNTIME_CONTROL_TEST_DATABASE_URL/);
  assert.match(runner, /\^\(BAIRUI_\|BETTER_AUTH_\|DATABASE_URL\$\)/);
  for (const file of [
    'runtime-control-contract.test.mjs',
    'runtime-control-envelope.test.mjs',
    'runtime-control-memory.test.mjs',
    'runtime-driver.test.mjs',
    'runtime-controller.test.mjs',
    'runtime-control-postgres.test.mjs',
  ]) assert.match(runner, new RegExp(file.replaceAll('.', '\\.')));
});
