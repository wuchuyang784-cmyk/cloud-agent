import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { MemoryOrchestratorLedger } from '../src/runtime/orchestrator/ledger.mjs';
import { createOrchestratorServer } from '../src/runtime/orchestrator/http.mjs';
import { signControlRequest, verifyControlRequestAsync, verifyControlResponse } from '../src/runtime/control-envelope.mjs';

const secret = randomBytes(32).toString('hex'); const keys = { primary: secret };
test('async nonce must finish before verification returns; replay and storage failure fail closed', async () => {
  const ledger = new MemoryOrchestratorLedger();
  const request = { method: 'GET', path: '/v1/runs/a', requestId: randomUUID(), keyId: 'primary', secret };
  const headers = signControlRequest(request);
  let consumed = false;
  const nonceStore = { consume: async (...args) => { await new Promise(resolve => setImmediate(resolve)); consumed = true; return ledger.consume(...args); } };
  await verifyControlRequestAsync({ ...request, headers, keys, nonceStore });
  assert.equal(consumed, true);
  await assert.rejects(verifyControlRequestAsync({ ...request, headers, keys, nonceStore }), /nonce_replayed/);
  await assert.rejects(verifyControlRequestAsync({ ...request, headers: signControlRequest(request), keys,
    nonceStore: { consume: async () => { throw new Error('database_unavailable'); } } }), /database_unavailable/);
});

test('HTTP authenticates, binds path/body, rejects unknown fields, signs errors and replays fail', async t => {
  const ledger = new MemoryOrchestratorLedger(); let starts = 0;
  const service = { start: async body => { starts++; return { ...body, status: 'running' }; }, inspect: async () => { throw new Error('run_not_found'); } };
  const server = createOrchestratorServer({ service, nonceStore: ledger, keys, allowTestHttp: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, input) => {
    const body = input ? JSON.stringify(input) : '';
    const requestId = randomUUID();
    const headers = signControlRequest({ method, path, body, requestId, keyId: 'primary', secret });
    const response = await fetch(origin + path, { method, headers, ...(body ? { body } : {}) });
    const raw = await response.text();
    verifyControlResponse({ status: response.status, requestId, requestNonce: headers['x-bairui-control-nonce'], body: raw, headers: response.headers, keys });
    return { status: response.status, value: JSON.parse(raw), headers, body };
  };
  const valid = { agentId: 'a', runId: 'a', runGeneration: 1, engine: 'pi', resourceSpec: { cpuMillis: 200, memoryBytes: 134217728, pidsLimit: 32, idleTtlSeconds: 60 } };
  assert.equal((await call('PUT', '/v1/runs/b', valid)).status, 400);
  assert.equal((await call('PUT', '/v1/runs/a', { ...valid, env: { SECRET: 'not accepted' } })).status, 400);
  assert.equal(starts, 0);
  const success = await call('PUT', '/v1/runs/a', valid);
  assert.equal(success.status, 200);
  assert.equal((await fetch(origin + '/v1/runs/a', { method: 'PUT', headers: success.headers, body: success.body })).status, 401);
  assert.equal(starts, 1);
  assert.equal((await call('GET', '/v1/runs/missing')).status, 404);
  assert.equal((await fetch(origin + '/v1/runs/a')).status, 401);
  assert.throws(() => createOrchestratorServer({ service, nonceStore: ledger, keys }), /tls_required/);
});
