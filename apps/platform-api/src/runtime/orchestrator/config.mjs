export function readOrchestratorConfig(env) {
  if (env.BAIRUI_ORCHESTRATOR_MODE !== 'isolation') throw new Error('orchestrator_isolation_mode_required');
  const required = ['BAIRUI_ORCHESTRATOR_DATABASE_URL', 'BAIRUI_ORCHESTRATOR_INSTALLATION', 'BAIRUI_ORCHESTRATOR_NETWORK',
    'BAIRUI_ORCHESTRATOR_IMAGE', 'BAIRUI_RUNTIME_CONTROL_KEY_ID', 'BAIRUI_RUNTIME_CONTROL_SECRET',
    'BAIRUI_ORCHESTRATOR_TLS_KEY_FILE', 'BAIRUI_ORCHESTRATOR_TLS_CERT_FILE'];
  if (required.some(key => !env[key])) throw new Error('orchestrator_config_missing');
  const port = Number(env.BAIRUI_ORCHESTRATOR_PORT ?? 9494);
  const intervalMs = Number(env.BAIRUI_ORCHESTRATOR_REAP_INTERVAL_MS ?? 5000);
  const connectionString = env.BAIRUI_ORCHESTRATOR_DATABASE_URL;
  let database;
  try { database = new URL(connectionString); } catch { throw new Error('orchestrator_config_invalid'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname.slice(1)
    || !Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000
    || !/^[a-zA-Z0-9._-]{1,64}$/.test(env.BAIRUI_RUNTIME_CONTROL_KEY_ID)
    || env.BAIRUI_RUNTIME_CONTROL_SECRET.length < 32 || env.BAIRUI_RUNTIME_CONTROL_SECRET.length > 4096
    || /[\u0000-\u001f\u007f]/.test(env.BAIRUI_RUNTIME_CONTROL_SECRET)) throw new Error('orchestrator_config_invalid');
  return { connectionString, installationId: env.BAIRUI_ORCHESTRATOR_INSTALLATION, network: env.BAIRUI_ORCHESTRATOR_NETWORK,
    image: env.BAIRUI_ORCHESTRATOR_IMAGE, keys: { [env.BAIRUI_RUNTIME_CONTROL_KEY_ID]: env.BAIRUI_RUNTIME_CONTROL_SECRET },
    keyFile: env.BAIRUI_ORCHESTRATOR_TLS_KEY_FILE, certFile: env.BAIRUI_ORCHESTRATOR_TLS_CERT_FILE,
    host: '127.0.0.1', port, intervalMs };
}
