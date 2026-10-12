// Explicit isolated entry only. Never imported by platform API/dev; never loads .env.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { readOrchestratorConfig } from './config.mjs';
import { PostgresOrchestratorLedger } from './ledger.mjs';
import { DockerOrchestratorDriver } from './docker.mjs';
import { Orchestrator } from './service.mjs';
import { createOrchestratorServer } from './http.mjs';

export async function startOrchestrator(env = process.env) {
  const config = readOrchestratorConfig(env);
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 6,
    connectionTimeoutMillis: 2000, statement_timeout: 3000, query_timeout: 5000, keepAlive: true });
  pool.on('error', () => console.error('orchestrator_database_unavailable'));
  let server; let timer; let pending; let closed = false;
  try {
    const ledger = new PostgresOrchestratorLedger({ pool, installationId: config.installationId });
    const docker = new DockerOrchestratorDriver(config);
    await ledger.check(); await docker.check();
    const service = new Orchestrator({ ledger, docker });
    server = createOrchestratorServer({ service, nonceStore: ledger, keys: config.keys,
      tls: { key: await readFile(config.keyFile), cert: await readFile(config.certFile) } });
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(config.port, config.host, resolve);
    });
    const sweep = () => {
      if (closed || pending) return;
      pending = service.reap().then(result => {
        if (result.reclaimed || result.failed) console.log(JSON.stringify({ event: 'orchestrator_reap', ...result }));
      }).catch(() => console.error('orchestrator_reap_unavailable')).finally(() => { pending = null; });
    };
    timer = setInterval(sweep, config.intervalMs); sweep();
    return { server, close: async () => {
      if (closed) return; closed = true; clearInterval(timer);
      await new Promise(resolve => server.close(resolve));
      await pending; await pool.end();
      // Deliberately retain containers and ledger; next instance reconciles them.
    } };
  } catch (error) {
    clearInterval(timer); server?.close(); await pool.end(); throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const instance = await startOrchestrator();
    console.log('orchestrator_isolation_ready');
    const stop = () => { void instance.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch { console.error('orchestrator_start_failed'); process.exitCode = 1; }
}
