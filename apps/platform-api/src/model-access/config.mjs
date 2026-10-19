import { constants, openSync, closeSync, lstatSync, fstatSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { createPrivateKey } from 'node:crypto';
import { credentialPublicKey } from './crypto.mjs';
import { assertExact, isProviderId, isModelId } from './validation.mjs';
import { ModelAccessError } from './errors.mjs';

const invalid = () => { throw new ModelAccessError('model_access_configuration_invalid'); };
const keyIdValid = value => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(value);
function filePath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.startsWith('\\\\') || /[\x00-\x1f\x7f]/.test(path) || path.split(/[\\/]/).includes('..')) invalid();
  return path;
}
function readProtected(path, secret = false) {
  filePath(path); const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) invalid();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > 65536
      || (secret && process.platform !== 'win32' && ((stat.mode & 0o077) || ![0, process.getuid()].includes(stat.uid)))) invalid();
    const data = Buffer.alloc(65537); let size = 0;
    for (;;) { const n = readSync(fd, data, size, data.length - size, null); size += n; if (size > 65536) invalid(); if (!n) break; }
    return data.subarray(0, size).toString('utf8');
  } finally { closeSync(fd); }
}
function providers(value, endpoints) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) invalid();
  const ids = new Set();
  return Object.freeze(value.map(item => {
    assertExact(item, endpoints ? ['id', 'baseUrl', 'models'] : ['id', 'models']);
    if (!isProviderId(item.id) || ids.has(item.id) || !Array.isArray(item.models) || item.models.length < 1 || item.models.length > 64
      || new Set(item.models).size !== item.models.length || item.models.some(model => !isModelId(model))) invalid();
    ids.add(item.id);
    if (endpoints) {
      const url = new URL(item.baseUrl);
      if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
        || url.hostname.endsWith('.') || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !/^[a-zA-Z0-9.-]+$/.test(url.hostname)
        || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)
        || !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname) || !url.pathname.endsWith('/v1')
        || url.pathname.includes('//') || item.baseUrl !== url.href) invalid();
    }
    return Object.freeze({ ...item, models: Object.freeze([...item.models]) });
  }));
}
export function validateCredentialConfiguration(value) {
  try {
    assertExact(value, ['keyId', 'publicKeyPem', 'providers']);
    if (typeof value.keyId !== 'string' || !keyIdValid(value.keyId)) invalid();
    const publicKey = credentialPublicKey(value.publicKeyPem);
    return Object.freeze({ ...value, publicKey, providers: providers(value.providers, false) });
  } catch { invalid(); }
}
export function readCredentialConfiguration(env = {}) {
  try {
    if (env.BAIRUI_MODEL_CREDENTIALS_ENABLED === undefined || env.BAIRUI_MODEL_CREDENTIALS_ENABLED === '0') return null;
    if (env.BAIRUI_MODEL_CREDENTIALS_ENABLED !== '1') invalid();
    return validateCredentialConfiguration(JSON.parse(readProtected(env.BAIRUI_MODEL_CREDENTIALS_CONFIG_FILE)));
  } catch { invalid(); }
}
export function validateGatewayConfiguration(value) {
  try {
    assertExact(value, ['databaseUrl', 'privateKeyFiles', 'providers', 'tlsKeyFile', 'tlsCertFile', 'host', 'port']);
    const db = new URL(value.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.hostname || !db.username || !db.password || !db.pathname.slice(1) || db.search || db.hash
      || !['127.0.0.1', '0.0.0.0'].includes(value.host) || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) invalid();
    if (!value.privateKeyFiles || Object.getPrototypeOf(value.privateKeyFiles) !== Object.prototype || !Object.keys(value.privateKeyFiles).length || Object.keys(value.privateKeyFiles).length > 8) invalid();
    for (const [id, path] of Object.entries(value.privateKeyFiles)) { if (!keyIdValid(id)) invalid(); filePath(path); }
    filePath(value.tlsKeyFile); filePath(value.tlsCertFile);
    return Object.freeze({ ...value, privateKeyFiles: Object.freeze({ ...value.privateKeyFiles }), providers: providers(value.providers, true) });
  } catch { invalid(); }
}
export async function readGatewayConfiguration(env = {}) {
  try {
    if (!['isolation', 'managed'].includes(env.BAIRUI_MODEL_GATEWAY_MODE)) invalid();
    const config = validateGatewayConfiguration(JSON.parse(readProtected(env.BAIRUI_MODEL_GATEWAY_CONFIG_FILE, true)));
    const privateKeys = Object.create(null);
    for (const [id, path] of Object.entries(config.privateKeyFiles)) {
      const key = createPrivateKey(readProtected(path, true));
      if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 3072 || key.asymmetricKeyDetails.modulusLength > 8192) invalid();
      privateKeys[id] = key;
    }
    return Object.freeze({ ...config, privateKeys: Object.freeze(privateKeys), tlsKey: readProtected(config.tlsKeyFile, true), tlsCert: readProtected(config.tlsCertFile) });
  } catch { invalid(); }
}
