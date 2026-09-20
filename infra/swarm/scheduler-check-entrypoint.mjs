// Mounted only into disposable acceptance services, never the normal API entrypoint.
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { Pool } from 'pg';

if (process.env.NODE_ENV !== 'test') throw new Error('check_entrypoint_requires_test_mode');
Object.assign(process.env, JSON.parse(await readFile('/run/secrets/check-env', 'utf8')));
if (process.env.CHECK_ROLE === 'api') {
  const { createApp } = await import('./src/app.mjs');
  const app = createApp({ databaseOptions: { max: 5 } });
  const { createClientIPResolver } = await import('./src/auth/client-ip.mjs');
  const clientIP = createClientIPResolver();
  app.prependListener('request', (req, res) => {
    res.setHeader('x-check-instance', hostname());
    res.setHeader('x-check-peer', req.socket.remoteAddress);
    try { res.setHeader('x-check-client-ip', clientIP(req)); } catch { /* API handles invalid chains. */ }
  });
  await app.platform.store.ping();
  app.listen(8080, '0.0.0.0');
  process.once('SIGTERM', () => app.close(async () => {
    await app.platform.store.close();
    process.exit(0);
  }));
} else if (process.env.CHECK_ROLE === 'worker') {
  const { PostgresTaskStore } = await import('./src/scheduler/task-store.mjs');
  const { runSimulationWorker } = await import('./src/scheduler/simulation-worker.mjs');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 5000 });
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  try {
    await pool.query('SELECT id FROM simulation_tasks LIMIT 0');
    await runSimulationWorker(new PostgresTaskStore(pool), hostname(), {
      signal: controller.signal,
      onError: error => console.error('simulation_worker_error', error.code ?? error.name),
    });
  } finally { await pool.end(); }
} else throw new Error('unknown_check_role');
