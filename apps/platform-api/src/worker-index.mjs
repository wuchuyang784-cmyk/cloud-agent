import { MemoryStore } from './store.mjs';
import { PostgresStore } from './postgres-store.mjs';
import { createRuntimeResolver } from './runtime/engines/registry.mjs';
import { provisionPendingAgents } from './worker.mjs';

const store = process.env.DATABASE_URL ? new PostgresStore() : new MemoryStore();
// 真实引擎（pi/dsh）未就绪时统一回退 mock；接入后可按 agent.engine 选择运行时。
const runtime = createRuntimeResolver().resolve(process.env.BAIRUI_AGENT_ENGINE ?? 'mock').runtime;
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

console.log('platform-worker started');
try {
  await provisionPendingAgents({ store, runtime, signal: controller.signal, workerId: process.env.HOSTNAME ?? 'platform-worker' });
} finally {
  await store.close?.();
}
