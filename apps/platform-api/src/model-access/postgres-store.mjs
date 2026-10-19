import { rollbackForRelease } from '../postgres-transaction.mjs';
import { ModelAccessError } from './errors.mjs';
import { assertExact, validateScope, validateVersion, validateGrantInput, validateFinish, isUuid, isProviderId, isModelId } from './validation.mjs';

const invalid = () => { throw new ModelAccessError('invalid_model_input'); };
const uuid = value => { if (!isUuid(value)) invalid(); return value; };
function envelope(value) {
  assertExact(value, ['version', 'keyId', 'wrappedKey', 'iv', 'ciphertext', 'tag']);
  if (value.version !== 1 || typeof value.keyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(value.keyId)) invalid();
  for (const [key, min, max] of [['wrappedKey', 384, 1024], ['iv', 12, 12], ['ciphertext', 16, 4096], ['tag', 16, 16]]) {
    const v = value[key];
    if (typeof v !== 'string' || v.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(v)) invalid();
    const data = Buffer.from(v, 'base64url');
    if (data.length < min || data.length > max || data.toString('base64url') !== v) invalid();
  }
  return value;
}

// Pools are supplied by the caller, with separate API/issuer/gateway grants.
// No environment lookup or process-local fallback is permitted here.
export class PostgresModelAccessStore {
  constructor({ pool }) {
    if (typeof pool?.connect !== 'function') throw new ModelAccessError('model_access_configuration_invalid');
    this.pool = pool;
  }
  async #call(sql, values) {
    let client, releaseError, connectionError, commitPending = false;
    const onError = error => { connectionError = error || true; };
    try {
      client = await this.pool.connect();
      client.on('error', onError);
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout = '3s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      const { rows } = await client.query(sql, values);
      if (connectionError) throw connectionError;
      const result = rows[0]?.result;
      if (result === null || result === undefined) throw new ModelAccessError('model_access_unavailable');
      commitPending = true;
      await client.query('COMMIT');
      commitPending = false;
      if (connectionError) throw connectionError;
      if (result.error) throw new ModelAccessError(result.error);
      return result;
    } catch (error) {
      if (client) releaseError = await rollbackForRelease(client);
      if (commitPending) releaseError ||= error || true;
      if (error instanceof ModelAccessError) throw error;
      if (error?.code === '22023' || error?.code === '22P02') throw new ModelAccessError('invalid_model_input');
      if (error?.code === '42501') throw new ModelAccessError('model_access_denied');
      throw new ModelAccessError('model_access_unavailable');
    } finally {
      if (client) { client.removeListener('error', onError); client.release(connectionError || releaseError); }
    }
  }
  listCredentials(scope) {
    validateScope(scope);
    return this.#call('SELECT model_credential_list($1,$2) AS result', [scope.organizationId, scope.userId]);
  }
  getCredential(scope, id) {
    validateScope(scope); uuid(id);
    return this.#call('SELECT model_credential_get($1,$2,$3::uuid) AS result', [scope.organizationId, scope.userId, id]);
  }
  createCredential(scope, input) {
    validateScope(scope); assertExact(input, ['id', 'provider', 'label', 'envelope']); uuid(input.id); envelope(input.envelope);
    if (!isProviderId(input.provider) || typeof input.label !== 'string' || input.label !== input.label.trim() || input.label.length < 1 || input.label.length > 80 || /[\x00-\x1f\x7f]/.test(input.label)) invalid();
    return this.#call('SELECT model_credential_create($1,$2,$3::jsonb) AS result', [scope.organizationId, scope.userId, JSON.stringify(input)]);
  }
  rotateCredential(scope, id, input) {
    validateScope(scope); uuid(id); assertExact(input, ['expectedVersion', 'envelope']); validateVersion(input.expectedVersion); envelope(input.envelope);
    return this.#call('SELECT model_credential_rotate($1,$2,$3::uuid,$4::integer,$5::jsonb) AS result', [scope.organizationId, scope.userId, id, input.expectedVersion, JSON.stringify(input.envelope)]);
  }
  revokeCredential(scope, id, expectedVersion) {
    validateScope(scope); uuid(id); validateVersion(expectedVersion);
    return this.#call('SELECT model_credential_revoke($1,$2,$3::uuid,$4::integer) AS result', [scope.organizationId, scope.userId, id, expectedVersion]);
  }
  issueGrant(input) {
    validateGrantInput(input);
    const { scope, ...value } = input;
    return this.#call('SELECT model_grant_issue($1,$2,$3::jsonb) AS result', [scope.organizationId, scope.userId, JSON.stringify(value)]);
  }
  async revokeGrant(id) { uuid(id); await this.#call('SELECT model_grant_revoke($1::uuid) AS result', [id]); }
  reserveRequest(input) {
    assertExact(input, ['tokenHash', 'requestId', 'model']);
    if (!/^[a-f0-9]{64}$/.test(input.tokenHash ?? '') || !isUuid(input.requestId) || !isModelId(input.model)) throw new ModelAccessError('model_grant_invalid');
    return this.#call('SELECT model_request_reserve($1,$2::uuid,$3) AS result', [input.tokenHash, input.requestId, input.model]);
  }
  finishRequest(requestId, result) {
    uuid(requestId); validateFinish(result);
    return this.#call('SELECT model_request_finish($1::uuid,$2,$3::bigint,$4::bigint) AS result', [requestId, result.state, result.inputTokens, result.outputTokens]);
  }
}
