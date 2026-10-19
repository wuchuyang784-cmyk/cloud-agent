import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpsRequest } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { Pool } from 'pg';
import { PostgresModelAccessStore } from '../src/model-access/postgres-store.mjs';
import { createCredentialService, issueRuntimeGrant } from '../src/model-access/service.mjs';
import { createProviderTransport } from '../src/model-access/transport.mjs';
import { createModelGateway } from '../src/model-access/gateway.mjs';
import { startModelGateway, verifyGatewayDatabase } from '../src/model-access/gateway-entry.mjs';
import { tlsFixture, modelChunk, modelEvent, providers, providerKey } from './helpers/model-access-fixture.mjs';
const connectionString = process.env.BAIRUI_MODEL_ACCESS_TEST_DATABASE_URL;

function call(port, ca, payload, token, path = '/v1/chat/completions') {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: '127.0.0.1', port, ca, path, method: payload === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, timeout: 5000 }, response => {
      let raw = ''; response.on('data', bytes => { raw += bytes; if (raw.length > 16384) request.destroy(); });
      response.on('end', () => resolve({ status: response.statusCode, raw })); response.on('error', reject);
    }); request.on('error', reject); request.on('timeout', () => request.destroy(new Error('fixture_timeout'))); request.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}

test('actual restricted PostgreSQL → TLS gateway → HTTPS Provider fixture, tools and usage; standalone least-privilege startup', { skip: !connectionString }, async t => {
  const suffix = randomUUID().replaceAll('-', ''), schema = 'live_model_' + suffix, password = randomBytes(24).toString('hex');
  const roles = Object.fromEntries(['app', 'issuer', 'gateway'].map(kind => [kind, 'live_' + kind + '_' + suffix]));
  const admin = new Pool({ connectionString }), owner = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' }), pools = {}, urls = {};
  let providerServer, gatewayServer, gateway, service;
  const directory = await mkdtemp(join(tmpdir(), 'f2-live-config-'));
  try {
    const tls = await tlsFixture(t), keys = generateKeyPairSync('rsa', { modulusLength: 3072 }), scope = { organizationId: 'org-a', userId: 'user-a' };
    await admin.query('CREATE SCHEMA ' + schema);
    const migrationDir = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const name of (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort()) await owner.query(await readFile(new URL(name, migrationDir), 'utf8'));
    await owner.query(`INSERT INTO organizations(id,name) VALUES('org-a','A'); INSERT INTO users(id,email) VALUES('user-a','a@live-model.test');
      INSERT INTO organization_members(organization_id,user_id,role) VALUES('org-a','user-a','user');
      INSERT INTO agents(id,organization_id,owner_user_id,name,status,runtime_kind,host,engine,template_version) VALUES('agent-a','org-a','user-a','A','ready','pi','agent-a.model.test','pi',1);
      INSERT INTO agent_engine_runs(id,organization_id,agent_id,engine,template_version,status,desired_state,subdomain,run_generation) VALUES('run-11111111-1111-4111-8111-111111111111','org-a','agent-a','pi',1,'running','running','agent-a.model.test',1);
      INSERT INTO agent_runtime_controls(agent_id,organization_id,owner_user_id,desired_state,generation,active_run_id,cpu_millis,memory_bytes,pids_limit,idle_ttl_seconds,change_reason) VALUES('agent-a','org-a','user-a','running',1,'run-11111111-1111-4111-8111-111111111111',100,134217728,16,60,'F2 live fixture');`);
    for (const [kind, role] of Object.entries(roles)) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
      await admin.query('ALTER ROLE ' + role + ' SET search_path=' + schema + ',public');
      await owner.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
      const url = new URL(connectionString); url.username = role; url.password = password; url.search = ''; urls[kind] = url.href;
      pools[kind] = new Pool({ connectionString: url.href, max: 2, connectionTimeoutMillis: 2000, query_timeout: 4500 });
    }
    await owner.query(`GRANT EXECUTE ON FUNCTION model_credential_list(text,text),model_credential_get(text,text,uuid),model_credential_create(text,text,jsonb),model_credential_rotate(text,text,uuid,integer,jsonb),model_credential_revoke(text,text,uuid,integer) TO ${roles.app};
      GRANT EXECUTE ON FUNCTION model_grant_issue(text,text,jsonb),model_grant_revoke(uuid) TO ${roles.issuer};
      GRANT EXECUTE ON FUNCTION model_request_reserve(text,uuid,text),model_request_finish(uuid,text,bigint,bigint) TO ${roles.gateway};`);
    await verifyGatewayDatabase(pools.gateway); await assert.rejects(verifyGatewayDatabase(owner), { code: 'model_access_configuration_invalid' });
    await owner.query(`GRANT EXECUTE ON FUNCTION model_grant_revoke(uuid) TO ${roles.gateway}`);
    await assert.rejects(verifyGatewayDatabase(pools.gateway), { code: 'model_access_configuration_invalid' });
    await owner.query(`REVOKE EXECUTE ON FUNCTION model_grant_revoke(uuid) FROM ${roles.gateway}`);
    const credentials = createCredentialService({ store: new PostgresModelAccessStore({ pool: pools.app }), configuration: { keyId: 'key-1', publicKey: keys.publicKey, providers } });
    const credential = await credentials.create(scope, { provider: 'provider-a', label: 'Live fixture', apiKey: providerKey });
    const grant = await issueRuntimeGrant({ store: new PostgresModelAccessStore({ pool: pools.issuer }), scope, credentialId: credential.id, agentId: 'agent-a', runId: 'run-11111111-1111-4111-8111-111111111111', runGeneration: 1, model: 'model-a', ttlSeconds: 300, maxRequests: 8 });
    let providerCalls = 0;
    providerServer = createServer(tls, async (request, response) => {
      providerCalls++; let raw = ''; for await (const bytes of request) raw += bytes;
      const payload = JSON.parse(raw); assert.equal(request.headers.authorization, 'Bearer ' + providerKey); assert.equal(request.headers.cookie, undefined);
      assert.equal(payload.max_completion_tokens, 4096); assert.equal(payload.stream_options.include_usage, true);
      const first = providerCalls === 1;
      const delta = first ? { tool_calls: [{ index: 0, id: 'call-read', type: 'function', function: { name: 'read', arguments: '{"path":"fixture.txt"}' } }] } : { content: 'fixture complete ' + providerKey };
      const stream = modelEvent(modelChunk(delta)) + modelEvent(modelChunk({}, first ? 'tool_calls' : 'stop')) + modelEvent({ ...modelChunk({}), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + modelEvent('[DONE]');
      response.writeHead(200, { 'content-type': 'text/event-stream' }); const bytes = Buffer.from(stream); response.write(bytes.subarray(0, 23)); response.end(bytes.subarray(23));
    });
    await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
    const transport = createProviderTransport({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: (options, callback) => httpsRequest({ ...options, port: providerServer.address().port, ca: tls.cert, lookup: (_h, _o, cb) => cb(null, '127.0.0.1', 4) }, callback) });
    gateway = createModelGateway({ store: new PostgresModelAccessStore({ pool: pools.gateway }), privateKeys: { 'key-1': keys.privateKey }, providers, transport });
    gatewayServer = createServer(tls, gateway.handler); await new Promise(resolve => gatewayServer.listen(0, '127.0.0.1', resolve));
    const message = { model: 'model-a', stream: true, max_completion_tokens: 16384, messages: [{ role: 'user', content: 'read fixture' }], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] };
    const first = await call(gatewayServer.address().port, tls.cert, message, grant.token); assert.equal(first.status, 200); assert.match(first.raw, /call-read/); assert.match(first.raw, /\[DONE\]/);
    const second = await call(gatewayServer.address().port, tls.cert, { ...message, messages: [...message.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call-read', type: 'function', function: { name: 'read', arguments: '{"path":"fixture.txt"}' } }] }, { role: 'tool', tool_call_id: 'call-read', content: 'fixture contents' }] }, grant.token);
    assert.equal(second.status, 200); assert.match(second.raw, /\[REDACTED\]/); assert.doesNotMatch(second.raw, new RegExp(providerKey + '|' + grant.token));
    const usage = (await owner.query('SELECT state,input_tokens,output_tokens FROM model_gateway_requests')).rows;
    assert.equal(usage.length, 2); assert.ok(usage.every(row => row.state === 'completed' && row.input_tokens === '10' && row.output_tokens === '5'));
    assert.doesNotMatch(JSON.stringify((await owner.query('SELECT * FROM model_access_audit')).rows), /fixture-provider-|ciphertext|token_hash|fixture contents/);
    await credentials.rotate(scope, credential.id, { expectedVersion: 1, apiKey: 'rotated-fixture-' + 'y'.repeat(30) });
    assert.equal((await call(gatewayServer.address().port, tls.cert, message, grant.token)).status, 401); assert.equal(providerCalls, 2);
    const privateFile = join(directory, 'private.pem'), tlsKeyFile = join(directory, 'tls.key'), tlsCertFile = join(directory, 'tls.crt'), configFile = join(directory, 'gateway.json');
    for (const [path, value] of [[privateFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' })], [tlsKeyFile, tls.key], [tlsCertFile, tls.cert]]) await writeFile(path, value, { mode: 0o600 });
    const portProbe = createTcpServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve)); const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
    await writeFile(configFile, JSON.stringify({ databaseUrl: urls.gateway, privateKeyFiles: { 'key-1': privateFile }, providers, tlsKeyFile, tlsCertFile, host: '127.0.0.1', port }), { mode: 0o600 });
    service = await startModelGateway({ env: { BAIRUI_MODEL_GATEWAY_MODE: 'isolation', BAIRUI_MODEL_GATEWAY_CONFIG_FILE: configFile } });
    assert.equal((await call(port, tls.cert, undefined, '', '/livez')).status, 200);
    assert.equal((await call(port, tls.cert, message, 'invalid')).status, 401);
    await service.stop(); service = null;
  } finally {
    if (service) await service.stop(); if (gateway) await gateway.shutdown();
    for (const server of [gatewayServer, providerServer]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const pool of Object.values(pools)) await pool.end(); await owner.end();
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); for (const role of Object.values(roles)) await admin.query('DROP ROLE IF EXISTS ' + role); await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
