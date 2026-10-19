import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { sealCredential } from './crypto.mjs';
import { validateScope, validateVersion, validateCredentialInput, isUuid } from './validation.mjs';
import { ModelAccessError } from './errors.mjs';

export function createCredentialService({ store, configuration }) {
  const context = (scope, id, provider, version) => ({ ...validateScope(scope), credentialId: id, provider, version });
  return {
    async list(scope) { return store.listCredentials(validateScope(scope)); },
    async create(scope, input) {
      validateScope(scope); const value = validateCredentialInput(input);
      if (!configuration.providers.some(provider => provider.id === value.provider)) throw new ModelAccessError('invalid_model_input');
      const id = randomUUID(), envelope = sealCredential({ publicKey: configuration.publicKey, keyId: configuration.keyId, context: context(scope, id, value.provider, 1), secret: value.apiKey });
      return store.createCredential(scope, { id, provider: value.provider, label: value.label, envelope });
    },
    async rotate(scope, id, input) {
      validateScope(scope); const value = validateCredentialInput(input, { rotate: true });
      if (!isUuid(id)) throw new ModelAccessError('model_credential_not_found');
      const previous = await store.getCredential(scope, id);
      if (!configuration.providers.some(provider => provider.id === previous.provider)) throw new ModelAccessError('invalid_model_input');
      const envelope = sealCredential({ publicKey: configuration.publicKey, keyId: configuration.keyId, context: context(scope, id, previous.provider, value.expectedVersion + 1), secret: value.apiKey });
      return store.rotateCredential(scope, id, { expectedVersion: value.expectedVersion, envelope });
    },
    async revoke(scope, id, expectedVersion) {
      validateScope(scope); validateVersion(expectedVersion);
      if (!isUuid(id)) throw new ModelAccessError('model_credential_not_found');
      return store.revokeCredential(scope, id, expectedVersion);
    },
  };
}
// Machine-only integration point for F4. Never exposed on a browser endpoint.
export async function issueRuntimeGrant({ store, ...input }) {
  const token = randomBytes(32).toString('base64url'), tokenHash = createHash('sha256').update(token).digest('hex');
  const grant = await store.issueGrant({ ...input, tokenHash });
  return { ...grant, token };
}
