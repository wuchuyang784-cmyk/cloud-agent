import { MemoryStore } from './store.mjs';
import { PostgresStore } from './postgres-store.mjs';
import { MockRuntime } from './runtime/mock-runtime.mjs';
import { provisionPendingAgents } from './worker.mjs';

const store = process.env.DATABASE_URL ? new PostgresStore() : new MemoryStore();
const runtime = new MockRuntime();
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

console.log('platform-worker started');
try {
  await provisionPendingAgents({ store, runtime, signal: controller.signal, workerId: process.env.HOSTNAME ?? 'platform-worker' });
} finally {
  await store.close?.();
}
