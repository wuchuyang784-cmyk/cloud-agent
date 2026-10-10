// Explicit isolation entry; no .env loading, Docker access or platform app import.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { readControllerConfig } from './config.mjs';
import { PostgresRuntimeControlStore } from '../postgres-control-store.mjs';
import { RemoteRuntimeDriver } from '../orchestration/remote-driver.mjs';
import { createSupervisionCoordinator } from './coordinator.mjs';
import { startControllerLoop } from './loop.mjs';
import { createRuntimeTelemetry } from './telemetry.mjs';

export async function startRuntimeController(env = process.env) {
  const config = readControllerConfig(env);
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 2,
    connectionTimeoutMillis: 2000, statement_timeout: 3000, query_timeout: 5000, keepAlive: true });
  pool.on('error', () => console.error('runtime_controller_database_unavailable'));
  let telemetry, loop, closing;
  try {
    const role = (await pool.query(`SELECT rolsuper,rolbypassrls,
      has_table_privilege(current_user,'agent_runtime_controls','SELECT,INSERT,UPDATE,DELETE') direct_access
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (!role || role.rolsuper || role.rolbypassrls || role.direct_access) throw new Error('runtime_controller_role_invalid');
    const store = new PostgresRuntimeControlStore({ pool });
    await store.supervisionSnapshot();
    const token = await readFile(config.tokenFile);
    if (token.byteLength > 258) throw new Error('runtime_controller_token_invalid');
    telemetry = createRuntimeTelemetry({ ...config, token: token.toString('utf8').trim() });
    await telemetry.start();
    const driver = new RemoteRuntimeDriver({ env });
    loop = startControllerLoop({ ...config, telemetry,
      cycle: createSupervisionCoordinator({ store, driver, workerId: `controller-${randomUUID()}`, ...config }),
      onError: code => console.error(code) });
    return { server: telemetry.server, close() {
      closing ??= (async () => { await loop.close(); await telemetry.close(); await pool.end(); })();
      return closing;
    } };
  } catch (error) { await loop?.close(); await telemetry?.close(); await pool.end(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const controller = await startRuntimeController();
    console.log('runtime_controller_isolation_ready');
    const stop = () => { void controller.close().catch(() => { console.error('runtime_controller_shutdown_failed'); process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch { console.error('runtime_controller_start_failed'); process.exitCode = 1; }
}
