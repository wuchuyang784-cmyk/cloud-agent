import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { MemoryStore } from '../src/store.mjs';
import { MemoryRuntimeControlStore } from '../src/runtime/control-store.mjs';
let stores = {}, services = {};
try { stores = await import('../src/model-access/memory-store.mjs'); services = await import('../src/model-access/service.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
const scope = { organizationId: 'org-a', userId: 'user-a' }, other = { organizationId: 'org-b', userId: 'user-b' };
export function fixture() {
  let clock = Date.now();
  const platform = new MemoryStore({ seed: { users: [{ id: scope.userId, email: 'a@example.test', organizationId: scope.organizationId }, { id: other.userId, email: 'b@example.test', organizationId: other.organizationId }], agents: [{ id: 'agent-a', organizationId: scope.organizationId, ownerUserId: scope.userId, engine: 'pi' }] } });
  const runtime = new MemoryRuntimeControlStore();
  runtime.controls.set('agent-a', { agentId: 'agent-a', organizationId: scope.organizationId, ownerUserId: scope.userId, desiredState: 'running', activeRunId: 'run-' + randomUUID(), generation: 1, governanceVersion: 0 });
  const control = runtime.controls.get('agent-a');
  runtime.runs.set(control.activeRunId, { id: control.activeRunId, agentId: 'agent-a', engine: 'pi', organizationId: scope.organizationId, runGeneration: 1, status: 'running', desiredState: 'running' });
  const store = new stores.MemoryModelAccessStore({ platform, runtime, now: () => clock });
  const configuration = { keyId: 'key-1', publicKey: keys.publicKey, providers: [{ id: 'provider-a', models: ['model-a'] }] };
  const service = services.createCredentialService({ store, configuration });
  const create = () => service.create(scope, { provider: 'provider-a', label: 'My model', apiKey: 'fixture-key-' + 'x'.repeat(32) });
  const grant = credentialId => services.issueRuntimeGrant({ store, scope, credentialId, agentId: 'agent-a', runId: control.activeRunId, runGeneration: 1, model: 'model-a', ttlSeconds: 120, maxRequests: 3 });
  const reserve = token => store.reserveRequest({ tokenHash: createHash('sha256').update(token).digest('hex'), requestId: randomUUID(), model: 'model-a' });
  return { store, service, platform, runtime, control, create, grant, reserve, advance: ms => { clock += ms; } };
}
test('credential metadata is scoped and never returns plaintext, ciphertext or token', async () => {
  assert.equal(typeof stores.MemoryModelAccessStore, 'function'); assert.equal(typeof services.createCredentialService, 'function');
  const f = fixture(), credential = await f.create();
  assert.equal(credential.version, 1); assert.equal(credential.status, 'active');
  assert.equal((await f.service.list(scope)).length, 1); assert.deepEqual(await f.service.list(other), []);
  assert.doesNotMatch(JSON.stringify(credential), /fixture-key|ciphertext|envelope|tokenHash/);
  await assert.rejects(f.service.rotate(other, credential.id, { expectedVersion: 1, apiKey: 'fixture-key-' + 'y'.repeat(32) }), { code: 'model_credential_not_found' });
});
test('rotation and revoke fence old grants and reject stale mutation versions', async () => {
  assert.equal(typeof services.issueRuntimeGrant, 'function'); const f = fixture(), c = await f.create(), g = await f.grant(c.id);
  assert.match(g.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(JSON.stringify([...f.store.grants.values()]).includes(g.token), false);
  const updated = await f.service.rotate(scope, c.id, { expectedVersion: 1, apiKey: 'new-fixture-' + 'z'.repeat(32) }); assert.equal(updated.version, 2);
  await assert.rejects(f.reserve(g.token), { code: 'model_grant_invalid' });
  await assert.rejects(f.service.revoke(scope, c.id, 1), { code: 'model_access_conflict' });
  await f.service.revoke(scope, c.id, 2); assert.equal((await f.service.list(scope))[0].status, 'revoked');
});
test('admission binds owner, current runtime generation, account governance and expiry', async () => {
  assert.equal(typeof services.issueRuntimeGrant, 'function');
  for (const invalidate of [f => f.advance(120001), f => { f.control.desiredState = 'stopped'; }, f => { f.control.generation = 2; }, f => { f.control.activeRunId = 'run-' + randomUUID(); }, f => { f.platform.accountGovernance = new Map([[scope.userId, { status: 'suspended', version: 1 }]]); }]) {
    const f = fixture(), c = await f.create(), g = await f.grant(c.id); invalidate(f);
    await assert.rejects(f.reserve(g.token), { code: 'model_grant_invalid' });
  }
  const f = fixture(), c = await f.create();
  await assert.rejects(services.issueRuntimeGrant({ store: f.store, scope: other, credentialId: c.id, agentId: 'agent-a', runId: f.control.activeRunId, runGeneration: 1, model: 'model-a', ttlSeconds: 120, maxRequests: 3 }), { code: 'model_grant_invalid' });
});
test('one active request per run, atomic call budget and terminal receipt cannot be overwritten', async () => {
  assert.equal(typeof services.issueRuntimeGrant, 'function'); const f = fixture(), c = await f.create(), g = await f.grant(c.id);
  const attempted = await Promise.allSettled([f.reserve(g.token), f.reserve(g.token)]);
  assert.equal(attempted.filter(r => r.status === 'fulfilled').length, 1);
  const first = attempted.find(r => r.status === 'fulfilled').value;
  await f.store.finishRequest(first.requestId, { state: 'completed', inputTokens: null, outputTokens: null });
  await assert.rejects(f.store.finishRequest(first.requestId, { state: 'completed', inputTokens: 999, outputTokens: 999 }), { code: 'model_access_conflict' });
  for (let i = 0; i < 2; i++) { const r = await f.reserve(g.token); await f.store.finishRequest(r.requestId, { state: 'unknown', inputTokens: null, outputTokens: null }); }
  await assert.rejects(f.reserve(g.token), { code: 'model_grant_invalid' });
  assert.equal(f.store.requests.get(first.requestId).inputTokens, null);
});
test('credential mutations validate catalog and quota, require active account, while suspended can read metadata', async () => {
  assert.equal(typeof stores.MemoryModelAccessStore, 'function'); const f = fixture(); await f.create();
  await assert.rejects(f.service.create(scope, { provider: 'unknown', label: 'x', apiKey: 'fixture-' + 'x'.repeat(30) }), { code: 'invalid_model_input' });
  for (let i = 1; i < 20; i++) await f.create();
  await assert.rejects(f.create(), { code: 'model_access_conflict' });
  f.platform.accountGovernance = new Map([[scope.userId, { status: 'suspended', version: 1 }]]);
  assert.equal((await f.service.list(scope)).length, 20); await assert.rejects(f.create(), { code: 'model_access_denied' });
  f.platform.accountGovernance.set(scope.userId, { status: 'banned', version: 2 }); await assert.rejects(f.service.list(scope), { code: 'model_access_denied' });
});
test('admission rejects control governance drift and non-pi run even with unchanged account', async () => {
  for (const invalidate of [f => { f.control.governanceVersion = 1; }, f => { f.runtime.runs.get(f.control.activeRunId).engine = 'dsh'; }]) {
    const f = fixture(), c = await f.create(), g = await f.grant(c.id); invalidate(f);
    await assert.rejects(f.reserve(g.token), { code: 'model_grant_invalid' });
  }
});
test('issuer rejects malformed run IDs before looking up runtime state', async () => {
  const f = fixture(), c = await f.create();
  await assert.rejects(services.issueRuntimeGrant({ store: f.store, scope, credentialId: c.id, agentId: 'agent-a', runId: 'run-' + '-'.repeat(36), runGeneration: 1, model: 'model-a', ttlSeconds: 120, maxRequests: 3 }), { code: 'invalid_model_input' });
});
test('expired receipt becomes unknown without refund and separate grants still share one run slot', async () => {
  const f = fixture(), c = await f.create(), firstGrant = await f.grant(c.id), secondGrant = await f.grant(c.id);
  const first = await f.reserve(firstGrant.token);
  await assert.rejects(f.reserve(secondGrant.token), { code: 'model_gateway_busy' });
  f.advance(125001);
  await assert.rejects(f.store.finishRequest(first.requestId, { state: 'completed', inputTokens: 1, outputTokens: 1 }), { code: 'model_access_conflict' });
  assert.equal(f.store.requests.get(first.requestId).state, 'unknown');
  assert.equal([...f.store.grants.values()].find(g => g.id === firstGrant.grantId).usedRequests, 1);
  const fresh = await f.grant(c.id), second = await f.reserve(fresh.token);
  f.control.desiredState = 'stopped';
  await f.store.finishRequest(second.requestId, { state: 'failed', inputTokens: null, outputTokens: null });
});
test('issuer rejects a non-string digest rather than storing a coerced token hash', async () => {
  const f = fixture(), c = await f.create();
  await assert.rejects(f.store.issueGrant({ scope, credentialId: c.id, agentId: 'agent-a', runId: f.control.activeRunId, runGeneration: 1, model: 'model-a', tokenHash: ['a'.repeat(64)], ttlSeconds: 120, maxRequests: 3 }), { code: 'invalid_model_input' });
});
