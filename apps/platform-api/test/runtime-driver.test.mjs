// 运行时编排层测试（docs/32 §3.1）：
// 平台不再 docker run / 挂 docker.sock，实例生命周期由 RuntimeDriver 承担。
//   local  —— 本机子进程（开发 / CI）；
//   remote —— 外部编排拉起，平台登记 runtimeUrl 并巡检。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRuntimeDriver,
  LocalProcessDriver,
  RemoteRuntimeDriver,
} from '../src/runtime/orchestration/index.mjs';
import {
  MemoryNonceStore,
  signControlResponse,
  verifyControlRequest,
} from '../src/runtime/control-envelope.mjs';

const CONTROL_SECRET = 'runtime-driver-test-secret-at-least-32-characters';
const START_REQUEST_ID = '00000000-0000-4000-8000-000000000011';
const STOP_REQUEST_ID = '00000000-0000-4000-8000-000000000012';
const INSPECT_REQUEST_ID = '00000000-0000-4000-8000-000000000013';
const RESOURCE_SPEC = Object.freeze({ cpuMillis: 500, memoryBytes: 536870912, pidsLimit: 64, idleTtlSeconds: 900 });

function remoteOptions(overrides = {}) {
  return {
    env: { NODE_ENV: 'test' },
    orchestratorUrl: 'http://orchestrator.test',
    orchestratorKeyId: 'primary',
    orchestratorSecret: CONTROL_SECRET,
    allowedRuntimeHosts: ['agent-1.runtime.internal'],
    allowInsecureHttp: true,
    ...overrides,
  };
}

function signedJson(body, { requestId, nonce }, status = 200) {
  const raw = JSON.stringify(body);
  return new Response(raw, {
    status,
    headers: {
      'content-type': 'application/json',
      ...signControlResponse({ status, requestId, requestNonce: nonce, body: raw, keyId: 'primary', secret: CONTROL_SECRET }),
    },
  });
}

test('工厂：默认 local；remote 需显式指定；未知取值报错', () => {
  assert.equal(createRuntimeDriver({ env: {} }).name, 'local');
  assert.equal(createRuntimeDriver({ env: { BAIRUI_RUNTIME_DRIVER: 'remote' } }).name, 'remote');
  assert.throws(
    () => createRuntimeDriver({ env: { BAIRUI_RUNTIME_DRIVER: 'docker' } }),
    /未知的 BAIRUI_RUNTIME_DRIVER/,
  );
});

test('local driver：默认可用；未登记实例 stop/route 安全返回', async () => {
  const driver = new LocalProcessDriver({ env: {} });
  assert.equal(driver.name, 'local');
  assert.equal(driver.canRun().ok, true);
  assert.deepEqual(await driver.stop({ agentId: 'nope' }), { stopped: false, reason: 'not_found' });
  assert.equal(driver.route({ agentId: 'nope' }).runtimeUrl, null);
  assert.equal((await driver.health({ agentId: 'nope' })).status, 'unknown');
});

test('remote driver：未配编排器不可用', async () => {
  const driver = new RemoteRuntimeDriver({ env: {} });
  assert.equal(driver.canRun().ok, false);
  assert.equal(driver.instances, undefined, 'remote control must not inherit an in-memory instance registry');
  assert.match(driver.canRun().reason, /配置不完整/);
  await assert.rejects(() => driver.provision({ agentId: 'agent-1' }), /remote_driver_unavailable/);
});

test('remote driver：签名调用固定 v1 接口且不转发 env', async () => {
  const requested = [];
  const nonceStore = new MemoryNonceStore();
  const driver = new RemoteRuntimeDriver(remoteOptions({
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      const raw = options.body ?? '';
      const verified = verifyControlRequest({
        method: options.method,
        path: target.pathname + target.search,
        body: raw,
        headers: options.headers,
        keys: { primary: CONTROL_SECRET },
        nonceStore,
      });
      requested.push({ method: options.method, path: target.pathname, body: raw ? JSON.parse(raw) : null, redirect: options.redirect });
      if (options.method === 'PUT') {
        return signedJson({ agentId: 'agent-1', runId: 'run-1', runGeneration: 1, status: 'running', orchestratorRef: 'inst-1', runtimeUrl: 'http://agent-1.runtime.internal:8092', observedAt: '2026-10-08T00:00:00.000Z' }, verified);
      }
      if (options.method === 'GET') {
        return signedJson({ agentId: 'agent-1', runId: 'run-1', runGeneration: 1, status: 'running', orchestratorRef: 'inst-1', runtimeUrl: 'http://agent-1.runtime.internal:8092', observedAt: '2026-10-08T00:00:01.000Z' }, verified);
      }
      return signedJson({ agentId: 'agent-1', runId: 'run-1', runGeneration: 1, status: 'absent', confirmedAt: '2026-10-08T00:00:02.000Z' }, verified);
    },
  }));

  const result = await driver.provision({ agentId: 'agent-1', runId: 'run-1', runGeneration: 1, engine: 'pi', requestId: START_REQUEST_ID, resourceSpec: RESOURCE_SPEC, env: { SHOULD_NOT: 'leak' } });
  assert.equal(result.runtimeUrl, 'http://agent-1.runtime.internal:8092');
  assert.equal(result.orchestratorRef, 'inst-1');
  assert.deepEqual(requested[0].body, { agentId: 'agent-1', runId: 'run-1', runGeneration: 1, engine: 'pi', resourceSpec: RESOURCE_SPEC });
  assert.equal(requested[0].method, 'PUT');
  assert.equal(requested[0].path, '/v1/runs/run-1');
  assert.equal(requested[0].redirect, 'error');

  assert.equal((await driver.inspect({ agentId: 'agent-1', runId: 'run-1', runGeneration: 1, requestId: INSPECT_REQUEST_ID })).status, 'running');
  assert.equal((await driver.stop({ agentId: 'agent-1', runId: 'run-1', runGeneration: 1, fenceGeneration: 2, requestId: STOP_REQUEST_ID, reason: 'manual stop' })).status, 'absent');
  assert.deepEqual(requested.map((row) => row.method), ['PUT', 'GET', 'POST']);
});

test('remote driver：普通 404、未签名响应和身份错配都不能确认停止', async () => {
  const spec = { agentId: 'agent-1', runId: 'run-1', runGeneration: 1, fenceGeneration: 2, requestId: STOP_REQUEST_ID, reason: 'stop' };
  const notFound = new RemoteRuntimeDriver(remoteOptions({ fetchImpl: async (_url, options) => signedJson({ error: 'not_found' }, { requestId: STOP_REQUEST_ID, nonce: options.headers['x-bairui-control-nonce'] }, 404) }));
  await assert.rejects(() => notFound.stop(spec), /stop_not_confirmed/);
  const unsigned = new RemoteRuntimeDriver(remoteOptions({ fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) }));
  await assert.rejects(() => unsigned.stop(spec), /control_version_invalid/);
  const mismatched = new RemoteRuntimeDriver(remoteOptions({ fetchImpl: async (_url, options) => signedJson({ agentId: 'agent-2', runId: 'run-1', runGeneration: 1, status: 'stopped', confirmedAt: '2026-10-08T00:00:00.000Z' }, { requestId: STOP_REQUEST_ID, nonce: options.headers['x-bairui-control-nonce'] }) }));
  await assert.rejects(() => mismatched.stop(spec), /orchestrator_identity_mismatch/);
});

test('remote driver：结果未知、超限响应和非 allowlist runtime URL 均 fail closed', async () => {
  const startSpec = { agentId: 'agent-1', runId: 'run-1', runGeneration: 1, engine: 'pi', requestId: START_REQUEST_ID, resourceSpec: RESOURCE_SPEC };
  const unavailable = new RemoteRuntimeDriver(remoteOptions({ fetchImpl: async () => { throw new TypeError('network details'); } }));
  await assert.rejects(() => unavailable.provision(startSpec), /orchestrator_result_unknown/);

  const oversizedBody = JSON.stringify({ padding: 'x'.repeat(70_000) });
  const oversized = new RemoteRuntimeDriver(remoteOptions({ fetchImpl: async () => new Response(oversizedBody, { status: 200, headers: { 'content-type': 'application/json' } }) }));
  await assert.rejects(() => oversized.provision(startSpec), /orchestrator_response_too_large/);

  const unsafe = new RemoteRuntimeDriver(remoteOptions({ fetchImpl: async (_url, options) => signedJson({ agentId: 'agent-1', runId: 'run-1', runGeneration: 1, status: 'running', orchestratorRef: 'inst-1', runtimeUrl: 'http://evil.example:8092', observedAt: '2026-10-08T00:00:00.000Z' }, { requestId: START_REQUEST_ID, nonce: options.headers['x-bairui-control-nonce'] }) }));
  await assert.rejects(() => unsafe.provision(startSpec), /runtime_url_forbidden/);
});

test('remote driver：生产配置拒绝 HTTP 编排器和缺失控制密钥', () => {
  const insecure = new RemoteRuntimeDriver(remoteOptions({ env: { NODE_ENV: 'production' } }));
  assert.equal(insecure.canRun().ok, false);
  const missingSecret = new RemoteRuntimeDriver(remoteOptions({ orchestratorSecret: null }));
  assert.equal(missingSecret.canRun().ok, false);
});

test('remote driver：inspect 在网络调用前拒绝无效运行身份', async () => {
  let called = false;
  const driver = new RemoteRuntimeDriver(remoteOptions({ fetchImpl: async () => { called = true; throw new Error('must not call'); } }));
  await assert.rejects(
    () => driver.inspect({ agentId: 'agent-1', runId: '', runGeneration: 0, requestId: INSPECT_REQUEST_ID }),
    /runtime_identity_invalid/,
  );
  assert.equal(called, false);
});

test('remote driver: deadline includes a body that never finishes', async () => {
  const driver = new RemoteRuntimeDriver(remoteOptions({ requestTimeoutMs: 100,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'content-type': 'application/json' } }),
  }));
  const attempt = driver.provision({ agentId: 'agent-1', runId: 'run-1', runGeneration: 1, engine: 'pi', requestId: START_REQUEST_ID, resourceSpec: RESOURCE_SPEC });
  let watchdog;
  try {
    await assert.rejects(() => Promise.race([attempt, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('body_deadline_not_enforced')), 600); })]), /orchestrator_result_unknown/);
  } finally { clearTimeout(watchdog); }
});
