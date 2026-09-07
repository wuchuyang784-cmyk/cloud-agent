// 兼容别名：MockRuntime 已迁移为 engines/mock-engine.mjs 的 MockEngineAdapter。
// 新代码请通过 engines/registry.mjs 的 createRuntimeResolver 获取运行时。
export { MockEngineAdapter as MockRuntime } from './engines/mock-engine.mjs';
