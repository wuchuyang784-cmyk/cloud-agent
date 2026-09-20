import test from 'node:test';
import assert from 'node:assert/strict';

import { PiEngineAdapter } from '../src/runtime/engines/pi-engine.mjs';

const calls = [];

// 注入用桩 driver：只记录委托调用，不真的拉起进程或容器。
// docs/32 §3.1：实例生命周期已交给 RuntimeDriver，adapter 只负责信封协议与对话，
// 也不再执行 docker run / 挂载 docker.sock。
class StubDriver {
  constructor(options = {}) {
    this.name = options.name ?? 'stub';
    this.instances = new Map();
    this.provisioned = [];
    this.stopped = [];
    this.runtimeUrl = options.runtimeUrl ?? 'http://127.0.0.1:39001';
    this.canRunResult = options.canRunResult ?? { ok: true, reason: null };
  }

  canRun() {
    return this.canRunResult;
  }

  // 幂等语义与真实 driver 一致：已登记直接复用，不再重复拉起。
  async provision(spec) {
    const existing = this.instances.get(spec.agentId);
    if (existing) {
      return { runtimeUrl: existing.runtimeUrl, ref: 'stub-ref', status: 'running', mode: this.name };
    }
    this.provisioned.push(spec);
    this.instances.set(spec.agentId, { runtimeUrl: this.runtimeUrl });
    return { runtimeUrl: this.runtimeUrl, ref: 'stub-ref', status: 'running', mode: this.name };
  }

  async stop(spec) {
    const agentId = spec?.agentId ?? spec?.id ?? spec;
    this.stopped.push(agentId);
    this.instances.delete(agentId);
    return { stopped: true, ref: 'stub-ref' };
  }

  async health(spec) {
    const agentId = spec?.agentId ?? spec?.id ?? spec;
    return this.instances.has(agentId)
      ? { status: 'running', driver: this.name, runtimeUrl: this.runtimeUrl }
      : { status: 'unknown', driver: this.name };
  }

  route(spec) {
    const agentId = spec?.agentId ?? spec?.id ?? spec;
    const record = this.instances.get(agentId);
    return { runtimeUrl: record?.runtimeUrl ?? null };
  }
}

function makeAdapter(overrides = {}) {
  const driver = overrides.driver ?? new StubDriver();
  return new PiEngineAdapter({
    env: { BAIRUI_PI_LOCAL: '1' },
    sharedSecret: 'pi-test-secret',
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/v1/tasks')) {
        const body = JSON.parse(options.body);
        calls.push({ kind: 'task', url, headers: options.headers, body });
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: '回复：' + body.prompt, totalTokens: 9, engine: 'pi' }),
        };
      }
      return { ok: false, status: 404 };
    },
    ...overrides,
    driver,
  });
}

test('canRun：local 形态需 BAIRUI_PI_LOCAL=1；docker 形态已移除', () => {
  assert.equal(new PiEngineAdapter({ env: {} }).canRun().ok, false);
  // BAIRUI_ENGINE_PI_IMAGE（docker 形态）已在 docs/32 阶段 A 移除，不再是启用条件。
  assert.equal(new PiEngineAdapter({ env: { BAIRUI_ENGINE_PI_IMAGE: 'x' } }).canRun().ok, false);
  assert.equal(new PiEngineAdapter({ env: { BAIRUI_PI_LOCAL: '1' } }).canRun().ok, true);
});

test('canRun：driver 不可用时 pi 跟随不可用', () => {
  const driver = new StubDriver({ name: 'remote', canRunResult: { ok: false, reason: '未配置编排器' } });
  assert.equal(new PiEngineAdapter({ env: {}, driver }).canRun().ok, false);
});

test('spawn 委托 driver：实例 env 含 provider/model 与共享密钥', async () => {
  const driver = new StubDriver();
  const adapter = makeAdapter({ driver });
  const output = await adapter.spawn({ agentId: 'agent-pi-demo', provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(output.status, 'running');
  assert.equal(output.runtimeUrl, 'http://127.0.0.1:39001');
  assert.equal(output.mode, 'stub');

  const spec = driver.provisioned.at(-1);
  assert.equal(spec.agentId, 'agent-pi-demo');
  assert.equal(spec.env.AGENT_ID, 'agent-pi-demo');
  assert.equal(spec.env.PI_PROVIDER, 'deepseek');
  assert.equal(spec.env.PI_MODEL, 'deepseek-chat');
  assert.equal(spec.env.RUNTIME_SHARED_SECRET, 'pi-test-secret');
});

test('spawn 缺少 agentId → 拒绝', async () => {
  const adapter = makeAdapter();
  await assert.rejects(() => adapter.spawn({}), /agent id required/);
});

test('spawn 幂等：同 agent 重复 spawn 复用已运行实例', async () => {
  const driver = new StubDriver();
  const adapter = makeAdapter({ driver });
  await adapter.spawn({ agentId: 'agent-pi-demo' });
  driver.provisioned.length = 0;
  const second = await adapter.spawn({ agentId: 'agent-pi-demo' });
  assert.equal(driver.provisioned.length, 0, '不应再次拉起');
  assert.equal(second.runtimeUrl, 'http://127.0.0.1:39001');
});

test('streamChat：信封签名头 + 平台事件序列 + usage', async () => {
  calls.length = 0;
  const adapter = makeAdapter();
  await adapter.spawn({ agentId: 'agent-pi-demo' });
  const events = [];
  const usage = await adapter.streamChat({ agent: { id: 'agent-pi-demo' }, message: '你好', writeEvent: (event) => events.push(event) });
  assert.equal(usage.totalTokens, 9);
  assert.deepEqual(events, ['run.started', 'message.completed', 'run.completed']);

  const task = calls.find((item) => item.kind === 'task');
  assert.ok(task, '应调用 wrapper /v1/tasks');
  assert.ok(task.headers['x-bairui-signature'], '应带信封签名头');
  assert.ok(task.headers['x-bairui-timestamp']);
  assert.ok(task.headers['x-bairui-nonce']);
  assert.equal(task.body.prompt, '你好');
  assert.equal(task.body.reset, true);
});

test('streamChat 未 provision → 拒绝', async () => {
  const adapter = makeAdapter();
  await assert.rejects(
    () => adapter.streamChat({ agent: { id: 'agent-nowhere' }, message: 'hi' }),
    /not provisioned/,
  );
});

test('provision 短回路别名返回 runtimeUrl', async () => {
  const adapter = makeAdapter();
  const result = await adapter.provision({ id: 'agent-provisioned' });
  assert.equal(result.runtimeUrl, 'http://127.0.0.1:39001');
});

test('health / route / stop 生命周期委托 driver', async () => {
  const driver = new StubDriver();
  const adapter = makeAdapter({ driver });
  await adapter.spawn({ agentId: 'agent-pi-demo' });
  assert.equal(adapter.route({ agentId: 'agent-pi-demo' }).runtimeUrl, 'http://127.0.0.1:39001');
  assert.equal((await adapter.health({ agentId: 'agent-pi-demo' })).status, 'running');

  const stopped = await adapter.stop({ agentId: 'agent-pi-demo' });
  assert.equal(stopped.stopped, true);
  assert.deepEqual(driver.stopped, ['agent-pi-demo']);
  assert.equal(adapter.route({ agentId: 'agent-pi-demo' }).runtimeUrl, null);
  assert.equal((await adapter.health({ agentId: 'agent-pi-demo' })).status, 'unknown');
});

test('validate：非 pi 目标 manifest 被拒绝', () => {
  const adapter = makeAdapter();
  assert.deepEqual(adapter.validate(), { ok: true, errors: [] });
  assert.deepEqual(adapter.validate({ engine: 'pi', model: 'deepseek-chat' }), { ok: true, errors: [] });
  assert.equal(adapter.validate({ engine: 'dsh' }).ok, false);
});
