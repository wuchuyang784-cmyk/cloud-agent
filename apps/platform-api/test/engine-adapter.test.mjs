import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntimeResolver } from '../src/runtime/engines/registry.mjs';
import {
  ENGINE_KINDS,
  isEngineKind,
  MockEngineAdapter,
  PiEngineAdapter,
  DshEngineAdapter,
} from '../src/runtime/engines/index.mjs';
import { MockRuntime } from '../src/runtime/mock-runtime.mjs';

test('resolver 默认解析到 mock 且不触发 fallback', () => {
  const result = createRuntimeResolver({ env: {} }).resolve('mock');
  assert.equal(result.engine, 'mock');
  assert.equal(result.fallback, false);
  assert.equal(result.reason, null);
  assert.ok(result.runtime instanceof MockEngineAdapter);
});

test('dsh/pi 引擎未接入时回退 mock 并记录原因', () => {
  const resolver = createRuntimeResolver({ env: {} });
  for (const engine of ['dsh', 'pi']) {
    const result = resolver.resolve({ engine });
    assert.equal(result.engine, engine, '保留请求的目标引擎');
    assert.equal(result.fallback, true);
    assert.equal(result.runtime.engine, 'mock', '实际执行者回退为 mock');
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  }
});

test('未知引擎回退 mock', () => {
  const result = createRuntimeResolver({ env: {} }).resolve({ engine: 'hermes' });
  assert.equal(result.fallback, true);
  assert.match(result.reason, /未知引擎/);
});

test('resolver 支持注入可运行 adapter（引擎接入后的选择路径）', () => {
  const fakePi = { engine: 'pi', canRun: () => ({ ok: true }) };
  const resolver = createRuntimeResolver({ adapters: { pi: fakePi } });
  const result = resolver.resolve('pi');
  assert.equal(result.fallback, false);
  assert.equal(result.runtime, fakePi);
});

test('pi/dsh adapter 暴露 EngineAdapter 契约方法且初始不可用', () => {
  for (const Adapter of [PiEngineAdapter, DshEngineAdapter]) {
    const adapter = new Adapter({ env: {} });
    assert.equal(adapter.canRun().ok, false);
    for (const method of ['spawn', 'stop', 'health', 'route', 'validate']) {
      assert.equal(typeof adapter[method], 'function', `${adapter.engine}.${method}`);
    }
  }
});

test('引擎枚举常量与判定函数', () => {
  assert.deepEqual(ENGINE_KINDS, ['pi', 'dsh', 'mock']);
  assert.equal(isEngineKind('dsh'), true);
  assert.equal(isEngineKind('hermes'), false);
});

test('mock-runtime.mjs 兼容别名仍导出 MockRuntime', () => {
  assert.equal(MockRuntime, MockEngineAdapter);
});
