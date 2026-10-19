import { randomUUID } from 'node:crypto';
import { ModelAccessError } from './errors.mjs';
import { validateScope, validateVersion, validateGrantInput, validateFinish, isUuid, isModelId } from './validation.mjs';

const clone = value => structuredClone(value);
const fail = code => { throw new ModelAccessError(code); };
const metadata = ({ id, provider, label, version, status, createdAt, updatedAt }) => ({ id, provider, label, version, status, createdAt, updatedAt });
// In-memory contract implementation for isolated tests. Production entrypoints
// require PostgreSQL and never fall back to these process-local maps.
export class MemoryModelAccessStore {
  constructor({ platform, runtime, now = Date.now }) {
    if (!platform?.memberships || !platform?.users || !runtime?.controls || !runtime?.runs) fail('model_access_configuration_invalid');
    this.platform = platform; this.runtime = runtime; this.now = now;
    this.credentials = new Map(); this.grants = new Map(); this.requests = new Map(); this.audit = [];
  }
  #account(scope, write = false) {
    validateScope(scope);
    if (!this.platform.users.has(scope.userId) || !this.platform.memberships.has(scope.organizationId + ':' + scope.userId)) fail('model_access_denied');
    const account = this.platform.accountGovernance?.get(scope.userId) ?? { status: 'active', version: 0 };
    if (!['active', 'suspended', 'banned'].includes(account.status) || !Number.isInteger(account.version)) fail('model_access_unavailable');
    if (account.status === 'banned' || write && account.status !== 'active') fail('model_access_denied');
    return account;
  }
  #credential(scope, id) {
    const row = this.credentials.get(id);
    if (!row || row.organizationId !== scope.organizationId || row.userId !== scope.userId) fail('model_credential_not_found');
    return row;
  }
  #record(scope, action, fields = {}) { this.audit.push({ organizationId: scope.organizationId, userId: scope.userId, action, ...fields, occurredAt: this.now() }); }
  async listCredentials(scope) {
    this.#account(scope);
    return [...this.credentials.values()].filter(row => row.organizationId === scope.organizationId && row.userId === scope.userId)
      .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).slice(0, 50).map(metadata);
  }
  async getCredential(scope, id) { this.#account(scope); return metadata(this.#credential(scope, id)); }
  async createCredential(scope, input) {
    this.#account(scope, true);
    if (this.credentials.has(input.id) || [...this.credentials.values()].filter(row => row.organizationId === scope.organizationId && row.userId === scope.userId && row.status === 'active').length >= 20) fail('model_access_conflict');
    const time = new Date(this.now()).toISOString();
    const row = { ...scope, ...clone(input), version: 1, status: 'active', createdAt: time, updatedAt: time };
    this.credentials.set(row.id, row); this.#record(scope, 'credential_created', { credentialId: row.id }); return metadata(row);
  }
  async rotateCredential(scope, id, { expectedVersion, envelope }) {
    this.#account(scope, true); validateVersion(expectedVersion); const row = this.#credential(scope, id);
    if (row.status !== 'active' || row.version !== expectedVersion) fail('model_access_conflict');
    row.envelope = clone(envelope); row.version++; row.updatedAt = new Date(this.now()).toISOString();
    this.#record(scope, 'credential_rotated', { credentialId: id }); return metadata(row);
  }
  async revokeCredential(scope, id, expectedVersion) {
    this.#account(scope, true); validateVersion(expectedVersion); const row = this.#credential(scope, id);
    if (row.status !== 'active' || row.version !== expectedVersion) fail('model_access_conflict');
    row.status = 'revoked'; row.version++; row.updatedAt = new Date(this.now()).toISOString();
    this.#record(scope, 'credential_revoked', { credentialId: id }); return metadata(row);
  }
  #run(scope, input, admission) {
    const agent = this.platform.agents.get(input.agentId), c = this.runtime.controls.get(input.agentId), r = this.runtime.runs.get(input.runId);
    if (!agent || agent.organizationId !== scope.organizationId || agent.ownerUserId !== scope.userId || agent.engine !== 'pi'
      || !c || c.organizationId !== scope.organizationId || c.ownerUserId !== scope.userId || c.desiredState !== 'running' || c.activeRunId !== input.runId
      || c.generation !== input.runGeneration || !r || r.engine !== 'pi' || r.agentId !== input.agentId || r.organizationId !== scope.organizationId
      || r.runGeneration !== input.runGeneration || r.desiredState !== 'running' || !(admission ? ['running'] : ['initializing', 'running']).includes(r.status)) fail('model_grant_invalid');
    return c;
  }
  async issueGrant(input) {
    validateGrantInput(input); const { scope } = input;
    let account, credential;
    try { account = this.#account(scope, true); credential = this.#credential(scope, input.credentialId); } catch { fail('model_grant_invalid'); }
    const control = this.#run(scope, input, false);
    if (credential.status !== 'active' || control.governanceVersion !== account.version || this.grants.has(input.tokenHash)) fail('model_grant_invalid');
    const row = { ...clone(input), id: randomUUID(), credentialVersion: credential.version, governanceVersion: account.version, issuedAt: this.now(), expiresAt: this.now() + input.ttlSeconds * 1000, revokedAt: null, usedRequests: 0 };
    this.grants.set(input.tokenHash, row); this.#record(scope, 'grant_issued', { grantId: row.id, agentId: row.agentId, runId: row.runId });
    return { grantId: row.id, expiresAt: new Date(row.expiresAt).toISOString(), maxRequests: row.maxRequests };
  }
  async revokeGrant(grantId) {
    const row = [...this.grants.values()].find(grant => grant.id === grantId); if (!row) fail('model_grant_invalid');
    row.revokedAt = this.now(); this.#record(row.scope, 'grant_revoked', { grantId });
  }
  async reserveRequest({ tokenHash, requestId, model }) {
    if (!/^[a-f0-9]{64}$/.test(tokenHash ?? '') || !isUuid(requestId) || !isModelId(model)) fail('model_grant_invalid');
    const grant = this.grants.get(tokenHash);
    if (!grant || grant.revokedAt !== null || grant.expiresAt <= this.now() || grant.issuedAt > this.now() || grant.model !== model || grant.usedRequests >= grant.maxRequests) fail('model_grant_invalid');
    let account, credential;
    try { account = this.#account(grant.scope, true); credential = this.#credential(grant.scope, grant.credentialId); } catch { fail('model_grant_invalid'); }
    const control = this.#run(grant.scope, grant, true);
    if (account.version !== grant.governanceVersion || control.governanceVersion !== grant.governanceVersion || credential.status !== 'active' || credential.version !== grant.credentialVersion) fail('model_grant_invalid');
    for (const row of this.requests.values()) if (row.runId === grant.runId && row.state === 'active' && row.leaseUntil <= this.now()) { row.state = 'unknown'; row.finishedAt = this.now(); }
    if ([...this.requests.values()].some(row => row.runId === grant.runId && row.state === 'active')) fail('model_gateway_busy');
    if (this.requests.has(requestId)) fail('model_access_conflict');
    const row = { requestId, grantId: grant.id, runId: grant.runId, state: 'active', startedAt: this.now(), leaseUntil: this.now() + 125000, finishedAt: null, inputTokens: null, outputTokens: null };
    this.requests.set(requestId, row); grant.usedRequests++; this.#record(grant.scope, 'request_reserved', { requestId, grantId: grant.id });
    return { requestId, provider: credential.provider, model: grant.model, context: { ...grant.scope, credentialId: credential.id, provider: credential.provider, version: credential.version }, envelope: clone(credential.envelope) };
  }
  async finishRequest(requestId, result) {
    validateFinish(result); const row = this.requests.get(requestId);
    if (!row || row.state !== 'active') fail('model_access_conflict');
    if (row.leaseUntil <= this.now()) {
      row.state = 'unknown'; row.finishedAt = this.now();
      const grant = [...this.grants.values()].find(item => item.id === row.grantId);
      this.#record(grant.scope, 'request_unknown', { requestId });
      fail('model_access_conflict');
    }
    Object.assign(row, result, { finishedAt: this.now() });
    const grant = [...this.grants.values()].find(item => item.id === row.grantId);
    this.#record(grant.scope, 'request_' + result.state, { requestId }); return { state: row.state };
  }
}
