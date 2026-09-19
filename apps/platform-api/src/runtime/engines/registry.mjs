// 引擎运行时解析器：按目标 engine 选择可运行 adapter，真实引擎未就绪时统一
// 回退 MockEngineAdapter（记录 fallback 原因），保证既有 Agent/会话/对话流程
// 在引擎接入前稳定可用。接入真实引擎只需：实现 adapter 方法体 + 放开 canRun()。

import { isEngineKind } from './contract.mjs';
import { MockEngineAdapter } from './mock-engine.mjs';
import { PiEngineAdapter } from './pi-engine.mjs';
import { DshEngineAdapter } from './dsh-engine.mjs';

export function createRuntimeResolver(options = {}) {
  const env = options.env ?? process.env;
  const runtimeOptions = options.runtimeOptions ?? {};

  // adapters 表：值为工厂函数或已实例化 adapter。
  const factories = options.adapters ?? {
    mock: () => new MockEngineAdapter(runtimeOptions),
    pi: () => new PiEngineAdapter({ env }),
    dsh: () => new DshEngineAdapter({ env }),
  };

  // 每个 engine 缓存同一 adapter 实例，保证 spawn/stop/health 等状态（实例表、运行记录）
  // 在多次 resolve 之间不丢失。
  const instances = new Map();

  const getAdapter = (kind) => {
    if (instances.has(kind)) return instances.get(kind);
    const entry = factories[kind];
    if (entry === undefined) return null;
    const instance = typeof entry === 'function' ? entry() : entry;
    instances.set(kind, instance);
    return instance;
  };

  const resolveMock = () => getAdapter('mock');

  /**
   * 解析可执行运行时。
   * @param {string|{ engine?: string }} [input] 'pi'|'dsh'|'mock'，或带 engine 的 agent。
   * @returns {{ runtime: object, engine: string, fallback: boolean, reason: string|null }}
   *   engine 为请求的目标引擎；fallback=true 表示实际执行者是 mock。
   */
  const resolve = (input = 'mock') => {
    const kind = typeof input === 'string' ? input : input?.engine ?? 'mock';
    if (kind === 'mock') {
      return { engine: 'mock', runtime: resolveMock(), fallback: false, reason: null };
    }
    if (!isEngineKind(kind)) {
      return { engine: kind, runtime: resolveMock(), fallback: true, reason: `未知引擎 "${kind}"，回退 mock` };
    }
    const adapter = getAdapter(kind);
    const capability = adapter?.canRun?.() ?? { ok: false, reason: `${kind} adapter 不可用` };
    if (capability.ok) {
      return { engine: kind, runtime: adapter, fallback: false, reason: null };
    }
    return {
      engine: kind,
      runtime: resolveMock(),
      fallback: true,
      reason: capability.reason ?? `${kind} 引擎未就绪，回退 mock`,
    };
  };

  return { resolve, getAdapter };
}
