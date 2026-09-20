import { createApp } from './app.mjs';
import { loadSecretEnv } from './secret-env.mjs';
import { createShutdown } from './service-lifecycle.mjs';
import { safeLog } from './observability/safe-log.mjs';

let app, drain;
try {
  const env = await loadSecretEnv(process.env);
  const port = Number(env.PORT ?? 8080);
  app = createApp({ env, databaseOptions: {
    max: Number(env.BAIRUI_DB_POOL_MAX ?? 20),
    connectionTimeoutMillis: Number(env.BAIRUI_DB_CONNECT_TIMEOUT_MS ?? 5000),
    queryTimeoutMillis: Number(env.BAIRUI_DB_QUERY_TIMEOUT_MS ?? 15000),
  } });

  drain = createShutdown(app);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 15000);
    Promise.all([drain(), app.platform.telemetry.close()]).then(() => {
      clearTimeout(timer);
      process.exit(0);
    }, () => {
      safeLog('api_shutdown_error');
      clearTimeout(timer);
      process.exit(1);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.platform.telemetry.start();
  if (!stopping) {
    await new Promise((resolve, reject) => {
      app.once('error', reject);
      app.listen(port, '0.0.0.0', () => { app.removeListener('error', reject); resolve(); });
    });
    safeLog('api_started', { level: 'info' });
  }
} catch {
  safeLog('api_startup_error');
  if (app) await Promise.all([drain?.(), app.platform.telemetry.close()]).catch(() => {});
  process.exit(1);
}
