import test from 'node:test';
import assert from 'node:assert/strict';
import { readOrchestratorConfig } from '../src/runtime/orchestrator/config.mjs';
import { readFile } from 'node:fs/promises';

test('independent entry fails closed without explicit isolation config and never falls back to business URL', () => {
  assert.throws(() => readOrchestratorConfig({ DATABASE_URL: 'postgres://business' }), /isolation_mode_required/);
  const env = { BAIRUI_ORCHESTRATOR_MODE: 'isolation', DATABASE_URL: 'postgres://business' };
  assert.throws(() => readOrchestratorConfig(env), /config_missing/);
  Object.assign(env, { BAIRUI_ORCHESTRATOR_DATABASE_URL: 'postgresql://worker:secret@localhost/isolated',
    BAIRUI_ORCHESTRATOR_INSTALLATION: 'isolation-test', BAIRUI_ORCHESTRATOR_NETWORK: 'isolation-net',
    BAIRUI_ORCHESTRATOR_IMAGE: `sha256:${'a'.repeat(64)}`, BAIRUI_RUNTIME_CONTROL_KEY_ID: 'primary',
    BAIRUI_RUNTIME_CONTROL_SECRET: 'a'.repeat(64), BAIRUI_ORCHESTRATOR_TLS_KEY_FILE: 'key.pem', BAIRUI_ORCHESTRATOR_TLS_CERT_FILE: 'cert.pem' });
  const config = readOrchestratorConfig(env);
  assert.equal(config.connectionString, env.BAIRUI_ORCHESTRATOR_DATABASE_URL);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 9494);
  assert.throws(() => readOrchestratorConfig({ ...env, BAIRUI_ORCHESTRATOR_PORT: '0' }), /config_invalid/);
  assert.throws(() => readOrchestratorConfig({ ...env, BAIRUI_RUNTIME_CONTROL_SECRET: 'weak' }), /config_invalid/);
});

test('isolated acceptance runner refuses image pulls and never loads project dotenv', async () => {
  const source = await readFile(new URL('../../../scripts/test-orchestrator.mjs', import.meta.url), 'utf8');
  assert.match(source, /\['run', '--pull=never'/);
  assert.ok(!source.includes('--env-file'));
  assert.match(source, /DATABASE_URL\$/);
  assert.match(source, /cleanup_owner_invalid/);
});
