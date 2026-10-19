import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
let api = {};
try { api = await import('../src/model-access/crypto.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
const context = { organizationId: 'org-a', userId: 'user-a', credentialId: randomUUID(), provider: 'provider-a', version: 1 };
const secret = 'fixture-only-secret-' + 'a'.repeat(32);
const seal = () => api.sealCredential({ publicKey: pair.publicKey, keyId: 'key-1', context, secret });
const open = (envelope, scope = context) => api.openCredential({ privateKeys: { 'key-1': pair.privateKey }, context: scope, envelope });

test('real public-key envelope round trips without storing plaintext and uses fresh randomness', () => {
  assert.equal(typeof api.sealCredential, 'function'); assert.equal(typeof api.openCredential, 'function');
  const first = seal(), second = seal();
  assert.equal(open(first), secret); assert.notDeepEqual(first, second);
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.deepEqual(Object.keys(first).sort(), ['ciphertext', 'iv', 'keyId', 'tag', 'version', 'wrappedKey']);
});
test('every owner, provider, credential and version binding is authenticated', () => {
  assert.equal(typeof api.openCredential, 'function');
  const envelope = seal();
  for (const field of Object.keys(context)) {
    const changed = { ...context, [field]: field === 'version' ? 2 : field === 'credentialId' ? randomUUID() : 'other' };
    assert.throws(() => open(envelope, changed), /model_credential_crypto_invalid/);
  }
});
test('ciphertext, wrapped key, tag, malformed encodings, unknown keys and wrong private key fail closed', () => {
  assert.equal(typeof api.openCredential, 'function');
  const envelope = seal();
  for (const field of ['ciphertext', 'iv', 'tag', 'wrappedKey']) {
    const altered = { ...envelope, [field]: (envelope[field][0] === 'A' ? 'B' : 'A') + envelope[field].slice(1) };
    assert.throws(() => open(altered), /model_credential_crypto_invalid/);
  }
  for (const altered of [{ ...envelope, keyId: 'unknown' }, { ...envelope, version: 2 }, { ...envelope, extra: true }, { ...envelope, tag: envelope.tag + '=' }, { ...envelope, ciphertext: 'a'.repeat(20000) }]) assert.throws(() => open(altered), /model_credential_crypto_invalid/);
  assert.throws(() => api.openCredential({ privateKeys: { 'key-1': pair.publicKey }, context, envelope }), /model_credential_crypto_invalid/);
});
test('API encryption rejects private or weak keys and malformed secrets without reflecting them', () => {
  assert.equal(typeof api.sealCredential, 'function');
  for (const value of ['', 'short', 'bad\r\nheader', 'a'.repeat(4097), 'contains spaces and-more', secret + '\n', 'a'.repeat(4096) + '\n']) {
    assert.throws(() => api.sealCredential({ publicKey: pair.publicKey, keyId: 'key-1', context, secret: value }), error => error.message === 'model_credential_crypto_invalid');
  }
  assert.throws(() => api.sealCredential({ publicKey: pair.privateKey, keyId: 'key-1', context, secret }), /model_credential_crypto_invalid/);
  const weak = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => api.sealCredential({ publicKey: weak.publicKey, keyId: 'key-1', context, secret }), /model_credential_crypto_invalid/);
});
