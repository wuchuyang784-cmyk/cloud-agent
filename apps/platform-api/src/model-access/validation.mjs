import { ModelAccessError } from './errors.mjs';
export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const isProviderId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
export const isModelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
export const isIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(value);
export function assertExact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new ModelAccessError('invalid_model_input');
}
export function validateScope(scope) {
  assertExact(scope, ['organizationId', 'userId']);
  if (!isIdentity(scope.organizationId) || !isIdentity(scope.userId)) throw new ModelAccessError('invalid_model_input');
  return { organizationId: scope.organizationId, userId: scope.userId };
}
export function validateVersion(value) {
  if (!Number.isInteger(value) || value < 1 || value >= 2147483647) throw new ModelAccessError('invalid_model_input');
  return value;
}
export function validateCredentialInput(input, { rotate = false } = {}) {
  assertExact(input, rotate ? ['apiKey', 'expectedVersion'] : ['provider', 'label', 'apiKey']);
  if (typeof input.apiKey !== 'string' || !/^[A-Za-z0-9._~+\/=-]{16,4096}$/.test(input.apiKey)) throw new ModelAccessError('invalid_model_input');
  if (rotate) validateVersion(input.expectedVersion);
  else if (!isProviderId(input.provider) || typeof input.label !== 'string' || input.label.trim().length < 1 || input.label.length > 80 || /[\x00-\x1f\x7f]/.test(input.label)) throw new ModelAccessError('invalid_model_input');
  return rotate ? { ...input } : { ...input, label: input.label.trim() };
}
export function validateGrantInput(input) {
  assertExact(input, ['scope', 'credentialId', 'agentId', 'runId', 'runGeneration', 'model', 'tokenHash', 'ttlSeconds', 'maxRequests']);
  validateScope(input.scope);
  if (!isUuid(input.credentialId) || !isIdentity(input.agentId) || !isUuid(typeof input.runId === 'string' ? input.runId.replace(/^run-/, '') : input.runId)
    || !Number.isSafeInteger(input.runGeneration) || input.runGeneration < 1 || !isModelId(input.model)
    || typeof input.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.tokenHash) || !Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 300
    || !Number.isInteger(input.maxRequests) || input.maxRequests < 1 || input.maxRequests > 32) throw new ModelAccessError('invalid_model_input');
  return input;
}
export function validateFinish(input) {
  assertExact(input, ['state', 'inputTokens', 'outputTokens']);
  if (!['completed', 'failed', 'unknown'].includes(input.state) || ![input.inputTokens, input.outputTokens].every(n => n === null || Number.isSafeInteger(n) && n >= 0)
    || (input.inputTokens === null) !== (input.outputTokens === null)
    || (input.state !== 'completed' && input.inputTokens !== null)) throw new ModelAccessError('invalid_model_input');
  return input;
}
