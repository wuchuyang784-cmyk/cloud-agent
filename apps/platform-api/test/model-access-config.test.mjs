import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let api = {};
try { api = await import('../src/model-access/config.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const pair = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const catalog = [{ id: 'provider-a', models: ['model-a'] }];
const publicConfig = { keyId: 'key-1', publicKeyPem: pair.publicKey, providers: catalog };
test('credential surface is disabled without touching a file and invalid switches fail closed', () => {
  assert.equal(typeof api.readCredentialConfiguration, 'function');
  assert.equal(api.readCredentialConfiguration({}), null);
  assert.equal(api.readCredentialConfiguration({ BAIRUI_MODEL_CREDENTIALS_ENABLED: '0', BAIRUI_MODEL_CREDENTIALS_CONFIG_FILE: '/missing' }), null);
  for (const env of [{ BAIRUI_MODEL_CREDENTIALS_ENABLED: 'true' }, { BAIRUI_MODEL_CREDENTIALS_ENABLED: '1' }]) assert.throws(() => api.readCredentialConfiguration(env), /model_access_configuration_invalid/);
});
test('API configuration is public-only and validates provider and model catalogs', () => {
  assert.equal(typeof api.validateCredentialConfiguration, 'function');
  const good = api.validateCredentialConfiguration(publicConfig); assert.ok(Object.isFrozen(good.providers));
  for (const bad of [{ ...publicConfig, publicKeyPem: pair.privateKey }, { ...publicConfig, privateKey: pair.privateKey }, { ...publicConfig, providers: [...catalog, ...catalog] }, { ...publicConfig, providers: [{ id: 'a', models: ['x', 'x'] }] }, { ...publicConfig, providers: [{ ...catalog[0], baseUrl: 'https://evil.example' }] }]) assert.throws(() => api.validateCredentialConfiguration(bad), /model_access_configuration_invalid/);
});
test('API public PEM must contain exactly one public block and no private material or trailing data', () => {
  for (const publicKeyPem of [pair.publicKey + pair.privateKey, pair.publicKey + pair.publicKey, pair.publicKey + 'junk']) {
    assert.throws(() => api.validateCredentialConfiguration({ ...publicConfig, publicKeyPem }), /model_access_configuration_invalid/);
  }
});

test('public identifiers cannot smuggle a final newline through a regex end anchor', () => {
  for (const value of [{ ...publicConfig, keyId: 'key-1\n' }, { ...publicConfig, providers: [{ id: 'provider-a\n', models: ['model-a'] }] }, { ...publicConfig, providers: [{ id: 'provider-a', models: ['model-a\n'] }] }]) {
    assert.throws(() => api.validateCredentialConfiguration(value), /model_access_configuration_invalid/);
  }
});

test('enabled API reads only an explicit bounded public file', t => {
  assert.equal(typeof api.readCredentialConfiguration, 'function');
  const directory = mkdtempSync(join(tmpdir(), 'f2-config-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'public.json'); writeFileSync(file, JSON.stringify(publicConfig));
  assert.equal(api.readCredentialConfiguration({ BAIRUI_MODEL_CREDENTIALS_ENABLED: '1', BAIRUI_MODEL_CREDENTIALS_CONFIG_FILE: file }).keyId, 'key-1');
  writeFileSync(file, 'x'.repeat(65537));
  assert.throws(() => api.readCredentialConfiguration({ BAIRUI_MODEL_CREDENTIALS_ENABLED: '1', BAIRUI_MODEL_CREDENTIALS_CONFIG_FILE: file }), /model_access_configuration_invalid/);
});
test('gateway configuration rejects dynamic, local or credential-bearing model endpoints', () => {
  assert.equal(typeof api.validateGatewayConfiguration, 'function');
  const config = { databaseUrl: 'postgresql://gateway:fixture@localhost/test', privateKeyFiles: { 'key-1': join(tmpdir(), 'private.pem') }, providers: [{ ...catalog[0], baseUrl: 'https://model.example/v1' }], tlsKeyFile: join(tmpdir(), 'tls.key'), tlsCertFile: join(tmpdir(), 'tls.crt'), host: '127.0.0.1', port: 9496 };
  assert.equal(api.validateGatewayConfiguration(config).port, 9496);
  for (const baseUrl of ['http://model.example/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://user:secret@model.example/v1', 'https://model.example:8443/v1', 'https://model.example/v1?url=x', 'https://model.example/v1#x']) assert.throws(() => api.validateGatewayConfiguration({ ...config, providers: [{ ...catalog[0], baseUrl }] }), /model_access_configuration_invalid/);
  for (const changed of [{ ...config, host: 'example.com' }, { ...config, port: 80 }, { ...config, extra: true }, { ...config, databaseUrl: 'postgresql://gateway:fixture@localhost/test?options=unsafe' }]) assert.throws(() => api.validateGatewayConfiguration(changed), /model_access_configuration_invalid/);
});
test('standalone gateway requires explicit mode and file, never business env fallback', async () => {
  assert.equal(typeof api.readGatewayConfiguration, 'function');
  for (const env of [{}, { DATABASE_URL: 'postgresql://not-used' }, { BAIRUI_MODEL_GATEWAY_MODE: 'isolation' }]) await assert.rejects(api.readGatewayConfiguration(env), /model_access_configuration_invalid/);
});

test('gateway loads a bounded explicit private key ring and TLS files', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'f2-gateway-config-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const privateFile = join(directory, 'private.pem'), tlsKeyFile = join(directory, 'tls.key'), tlsCertFile = join(directory, 'tls.crt'), configFile = join(directory, 'gateway.json');
  for (const [path, value] of [[privateFile, pair.privateKey], [tlsKeyFile, pair.privateKey], [tlsCertFile, 'fixture-certificate']]) writeFileSync(path, value, { mode: 0o600 });
  const config = { databaseUrl: 'postgresql://gateway:fixture@localhost/test', privateKeyFiles: { 'key-1': privateFile }, providers: [{ ...catalog[0], baseUrl: 'https://model.example/v1' }], tlsKeyFile, tlsCertFile, host: '127.0.0.1', port: 9496 };
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const env = { BAIRUI_MODEL_GATEWAY_MODE: 'isolation', BAIRUI_MODEL_GATEWAY_CONFIG_FILE: configFile };
  const loaded = await api.readGatewayConfiguration(env);
  assert.equal(loaded.privateKeys['key-1'].type, 'private'); assert.equal(loaded.tlsCert, 'fixture-certificate');
  assert.ok(Object.isFrozen(loaded.privateKeys));
  writeFileSync(privateFile, 'invalid-private-key'); await assert.rejects(api.readGatewayConfiguration(env), /model_access_configuration_invalid/);
  if (process.platform !== 'win32') {
    writeFileSync(privateFile, pair.privateKey); chmodSync(privateFile, 0o644);
    await assert.rejects(api.readGatewayConfiguration(env), /model_access_configuration_invalid/);
  }
});
