import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresTaskStore } from './task-store.mjs';
import { runSimulationWorker } from './simulation-worker.mjs';

if (process.env.BAIRUI_SIMULATION_ENABLED !== '1' || process.env.NODE_ENV === 'production' || !process.env.DATABASE_URL) {
  throw new Error('Simulation worker requires explicit non-production enablement and PostgreSQL');
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 5000 });
const controller = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort());
try {
  await pool.query('SELECT id FROM simulation_tasks LIMIT 0');
  await runSimulationWorker(new PostgresTaskStore(pool), 'simulation-' + randomUUID(), {
    signal: controller.signal,
    onError: e => console.error('simulation_worker_error', e.code ?? e.name),
  });
} finally { await pool.end(); }
