import { MemoryStore } from './store.mjs';
import { PostgresStore } from './postgres-store.mjs';
import { createRuntimeResolver } from './runtime/engines/registry.mjs';
import { provisionPendingAgents } from './worker.mjs';
import { assertAgentRuntimeEnabled } from './platform-config.mjs';

assertAgentRuntimeEnabled();
const store = process.env.DATABASE_URL ? new PostgresStore() : new MemoryStore();
// Worker 按每个 agent 的 engine 解析运行时（pi/dsh 未就绪时 registry 统一回退 mock）。
const resolver = createRuntimeResolver();
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

console.log('platform-worker started');
try {
  await provisionPendingAgents({ store, resolver, signal: controller.signal, workerId: process.env.HOSTNAME ?? 'platform-worker' });
} finally {
  await store.close?.();
}
