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
  assert.match(driver.canRun().reason, /BAIRUI_RUNTIME_ORCHESTRATOR_URL/);
  await assert.rejects(() => driver.provision({ agentId: 'a' }), /remote_driver_unavailable/);
});

test('remote driver：向编排器请求拉起、登记 runtimeUrl 并支持巡检/路由/回收', async () => {
  const requested = [];
  const driver = new RemoteRuntimeDriver({
    env: { BAIRUI_RUNTIME_ORCHESTRATOR_URL: 'http://orchestrator.test' },
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/instances') && options.method === 'POST') {
        requested.push(JSON.parse(options.body));
        return { ok: true, status: 200, json: async () => ({ runtimeUrl: 'http://agent-1.runtime:8092', ref: 'inst-1' }) };
      }
      if (url.endsWith('/healthz')) return { ok: true, status: 200 };
      return { ok: false, status: 404 };
    },
  });

  const result = await driver.provision({ agentId: 'agent-1', engine: 'pi', env: { PI_MODEL: 'deepseek-chat' } });
  assert.equal(result.runtimeUrl, 'http://agent-1.runtime:8092');
  assert.equal(result.ref, 'inst-1');
  assert.equal(result.mode, 'remote');
  assert.equal(requested[0].agentId, 'agent-1');
  assert.equal(requested[0].engine, 'pi');
  assert.equal(requested[0].env.PI_MODEL, 'deepseek-chat');

  assert.equal(driver.route({ agentId: 'agent-1' }).runtimeUrl, 'http://agent-1.runtime:8092');
  assert.equal((await driver.health({ agentId: 'agent-1' })).status, 'running');
  assert.equal((await driver.stop({ agentId: 'agent-1' })).stopped, true);
  assert.equal(driver.route({ agentId: 'agent-1' }).runtimeUrl, null);
});

test('remote driver：编排器拒绝时抛明确错误', async () => {
  const driver = new RemoteRuntimeDriver({
    env: { BAIRUI_RUNTIME_ORCHESTRATOR_URL: 'http://orchestrator.test' },
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(() => driver.provision({ agentId: 'a' }), /编排器拉起实例失败/);
});

test('remote driver：编排器未返回 runtimeUrl 时抛错', async () => {
  const driver = new RemoteRuntimeDriver({
    env: { BAIRUI_RUNTIME_ORCHESTRATOR_URL: 'http://orchestrator.test' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  await assert.rejects(() => driver.provision({ agentId: 'a' }), /编排器未返回 runtimeUrl/);
});
