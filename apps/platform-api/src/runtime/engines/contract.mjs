// Engine Adapter Layer 契约（docs/27 §4 / docs/28 §2 落地骨架）。
// 平台上层（control plane、console、worker、Channel Worker）只依赖本层暴露的
// 运行时就绪判定与适配器，不感知具体引擎差异。

/** 引擎枚举：pi（pi-agent）/ dsh（deepseek-harness）/ mock（平台内置模拟）。 */
export const ENGINE_KINDS = Object.freeze(['pi', 'dsh', 'mock']);

/** 判断字符串是否合法引擎枚举。 */
export function isEngineKind(value) {
  return typeof value === 'string' && ENGINE_KINDS.includes(value);
}

/**
 * EngineAdapter 接口（docs/28 §2.1 完整契约，真实接入后逐项实现）：
 * - engine: 'pi' | 'dsh'
 * - spawn(spec: AgentInstanceSpec): Promise<SpawnResult>
 * - stop(agentId): Promise<void>
 * - health(agentId): Promise<HealthResult>
 * - route(agentId): Promise<string>   // 返回当前 runtimeUrl，供网关/边界反代
 * - validate(manifest): Promise<{ ok, errors }>
 * 骨架阶段真实适配器通过 canRun() 报告未就绪，解析器统一回退 mock；
 * 引擎本体与容器编排就绪后再填充方法体并放开 canRun。
 */

/** 引擎适配器未就绪/未实现时抛出。 */
export class EngineAdapterError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'EngineAdapterError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** 通用占位：能力尚未实现。 */
export function notImplemented(engine, method) {
  throw new EngineAdapterError('engine_not_implemented', `${engine} adapter.${method}() 未实现：引擎本体/编排接入后再落地`);
}
