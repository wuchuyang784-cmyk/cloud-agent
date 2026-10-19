import { createCipheriv, createDecipheriv, createPublicKey, createPrivateKey, publicEncrypt, privateDecrypt, randomBytes, constants, KeyObject } from 'node:crypto';
import { ModelAccessError } from './errors.mjs';
import { assertExact, validateScope, isUuid, isProviderId } from './validation.mjs';

const invalid = () => { throw new ModelAccessError('model_credential_crypto_invalid'); };
const keyIdValid = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(value);
const secretValid = value => typeof value === 'string' && /^[A-Za-z0-9._~+\/=-]{16,4096}$/.test(value);
function rsa(key, type) {
  let value;
  if (key instanceof KeyObject) value = key;
  else {
    if (typeof key !== 'string' || key.length > 65536 || (type === 'public' && !/^[ \t\r\n]*-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END \1-----[ \t\r\n]*$/.test(key))) invalid();
    value = type === 'public' ? createPublicKey(key) : createPrivateKey(key);
  }
  if (value.type !== type || value.asymmetricKeyType !== 'rsa' || value.asymmetricKeyDetails.modulusLength < 3072 || value.asymmetricKeyDetails.modulusLength > 8192) invalid();
  return value;
}
export function credentialPublicKey(value) {
  try { return rsa(value, 'public'); } catch { invalid(); }
}
function aad(context, keyId) {
  assertExact(context, ['organizationId', 'userId', 'credentialId', 'provider', 'version']);
  validateScope({ organizationId: context.organizationId, userId: context.userId });
  if (!isUuid(context.credentialId) || !isProviderId(context.provider) || !Number.isSafeInteger(context.version) || context.version < 1 || !keyIdValid(keyId)) invalid();
  return Buffer.from(JSON.stringify([1, keyId, context.organizationId, context.userId, context.credentialId, context.provider, context.version]));
}
function decode(value, min, max = min) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const data = Buffer.from(value, 'base64url');
  if (data.length < min || data.length > max || data.toString('base64url') !== value) invalid();
  return data;
}
export function sealCredential({ publicKey, keyId, context, secret }) {
  let dataKey;
  try {
    const key = rsa(publicKey, 'public'), binding = aad(context, keyId);
    if (!secretValid(secret)) invalid();
    dataKey = randomBytes(32); const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv, { authTagLength: 16 }); cipher.setAAD(binding);
    const ciphertext = Buffer.concat([cipher.update(secret, 'ascii'), cipher.final()]);
    const wrappedKey = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dataKey);
    return { version: 1, keyId, wrappedKey: wrappedKey.toString('base64url'), iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  } catch { invalid(); } finally { dataKey?.fill(0); }
}
export function openCredential({ privateKeys, context, envelope }) {
  let dataKey, plaintext;
  try {
    assertExact(envelope, ['version', 'keyId', 'wrappedKey', 'iv', 'ciphertext', 'tag']);
    if (envelope.version !== 1 || !keyIdValid(envelope.keyId) || !privateKeys || !Object.hasOwn(privateKeys, envelope.keyId)) invalid();
    const binding = aad(context, envelope.keyId), key = rsa(privateKeys[envelope.keyId], 'private');
    dataKey = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, decode(envelope.wrappedKey, key.asymmetricKeyDetails.modulusLength / 8));
    if (dataKey.length !== 32) invalid();
    const decipher = createDecipheriv('aes-256-gcm', dataKey, decode(envelope.iv, 12), { authTagLength: 16 });
    decipher.setAAD(binding); decipher.setAuthTag(decode(envelope.tag, 16));
    plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext, 16, 4096)), decipher.final()]);
    const value = plaintext.toString('ascii'); if (!secretValid(value) || !Buffer.from(value, 'ascii').equals(plaintext)) invalid();
    return value;
  } catch { invalid(); } finally { dataKey?.fill(0); plaintext?.fill(0); }
}
