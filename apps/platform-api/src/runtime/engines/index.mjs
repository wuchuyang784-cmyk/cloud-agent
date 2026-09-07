// 引擎适配层聚合入口（docs/27 §4 Engine Adapter Layer）。
export { ENGINE_KINDS, isEngineKind, EngineAdapterError } from './contract.mjs';
export { MockEngineAdapter } from './mock-engine.mjs';
export { PiEngineAdapter } from './pi-engine.mjs';
export { DshEngineAdapter } from './dsh-engine.mjs';
export { createRuntimeResolver } from './registry.mjs';
