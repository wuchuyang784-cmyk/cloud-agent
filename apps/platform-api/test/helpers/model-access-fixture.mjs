import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../../src/store.mjs';
import { MemoryRuntimeControlStore } from '../../src/runtime/control-store.mjs';
import { MemoryModelAccessStore } from '../../src/model-access/memory-store.mjs';
import { createCredentialService, issueRuntimeGrant } from '../../src/model-access/service.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
export const providerKey = 'fixture-provider-' + 'x'.repeat(32);
export const scope = { organizationId: 'org-a', userId: 'user-a' };
export const providers = [{ id: 'provider-a', baseUrl: 'https://model.example/v1', models: ['model-a'] }];
export async function modelFixture() {
  const platform = new MemoryStore({ seed: { users: [{ id: scope.userId, email: 'a@model.test', organizationId: scope.organizationId }, { id: 'user-b', email: 'b@model.test', organizationId: 'org-b' }], agents: [{ id: 'agent-a', organizationId: scope.organizationId, ownerUserId: scope.userId, engine: 'pi' }] } });
  const runtime = new MemoryRuntimeControlStore(), runId = 'run-' + randomUUID();
  runtime.controls.set('agent-a', { agentId: 'agent-a', organizationId: scope.organizationId, ownerUserId: scope.userId, desiredState: 'running', activeRunId: runId, generation: 1, governanceVersion: 0 });
  runtime.runs.set(runId, { id: runId, agentId: 'agent-a', organizationId: scope.organizationId, engine: 'pi', runGeneration: 1, status: 'running', desiredState: 'running' });
  const store = new MemoryModelAccessStore({ platform, runtime });
  const configuration = { keyId: 'key-1', publicKey: keys.publicKey, providers: [{ id: 'provider-a', models: ['model-a'] }] };
  const service = createCredentialService({ store, configuration });
  const credential = await service.create(scope, { provider: 'provider-a', label: 'Fixture', apiKey: providerKey });
  const grant = await issueRuntimeGrant({ store, scope, credentialId: credential.id, agentId: 'agent-a', runId, runGeneration: 1, model: 'model-a', ttlSeconds: 300, maxRequests: 32 });
  return { platform, runtime, store, configuration, service, credential, grant, privateKeys: { 'key-1': keys.privateKey } };
}
export async function tlsFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'f2-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, 'tls.key'), certFile = join(directory, 'tls.crt');
  execFileSync('openssl', ['req', '-config', fileURLToPath(new URL('./orchestrator-tls.cnf', import.meta.url)), '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=model.example', '-addext', 'subjectAltName=DNS:model.example,DNS:localhost,IP:127.0.0.1', '-days', '1'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
  return { key: await readFile(keyFile), cert: await readFile(certFile) };
}
export const modelChunk = (delta, finish_reason = null, usage) => ({ id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: 'model-a', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
export const modelEvent = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
export const successStream = modelEvent(modelChunk({ role: 'assistant', content: '你好 fixture answer' })) + modelEvent(modelChunk({}, 'stop')) + modelEvent({ ...modelChunk({}), choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + modelEvent('[DONE]');
