import { RemoteRuntimeDriver } from '../orchestration/remote-driver.mjs';
import { isIP } from 'node:net';

const csv = value => String(value ?? '').split(',').map(value => value.trim()).filter(Boolean);
function preciseRange(value) {
  const parts = value.split('/');
  const family = isIP(parts[0]);
  return family && (parts.length === 1 || (parts.length === 2 && /^[0-9]+$/.test(parts[1])
    && Number(parts[1]) > 0 && Number(parts[1]) <= (family === 4 ? 32 : 128)));
}

export function readControllerConfig(env) {
  if (env.BAIRUI_RUNTIME_CONTROLLER_MODE !== 'isolation') throw new Error('runtime_controller_isolation_mode_required');
  const connectionString = env.BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL;
  let database;
  try { database = new URL(connectionString); } catch { throw new Error('runtime_controller_config_invalid'); }
  // pg's query parameters can override authority/path connection fields.
  // Allow only a fixed search_path; no host/database/role/credential overrides.
  const parameters = [...database.searchParams];
  if (parameters.length > 1 || parameters.some(([key, value]) => key !== 'options'
    || !/^-c search_path=[a-z][a-z0-9_]{0,62}(?:,public)?$/.test(value))) throw new Error('runtime_controller_config_invalid');
  const intervalMs = Number(env.BAIRUI_RUNTIME_CONTROLLER_INTERVAL_MS ?? 1000);
  const batchSize = Number(env.BAIRUI_RUNTIME_CONTROLLER_BATCH_SIZE ?? 1);
  const maxAttempts = Number(env.BAIRUI_RUNTIME_CONTROLLER_MAX_ATTEMPTS ?? 8);
  const port = Number(env.BAIRUI_RUNTIME_CONTROLLER_METRICS_PORT ?? 9495);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
    || !database.username || !database.pathname.slice(1) || ['bairui', 'bairui_preprod', 'postgres'].includes(decodeURIComponent(database.pathname.slice(1)))
    || connectionString === env.DATABASE_URL || !env.BAIRUI_RUNTIME_CONTROLLER_METRICS_TOKEN_FILE
    || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 10000
    || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100
    || !Number.isSafeInteger(port) || port < 1024 || port > 65535
    || typeof env.BAIRUI_RUNTIME_CONTROL_SECRET !== 'string' || env.BAIRUI_RUNTIME_CONTROL_SECRET.length < 32
    || env.BAIRUI_RUNTIME_CONTROL_SECRET.length > 4096 || /[\u0000-\u001f\u007f]/.test(env.BAIRUI_RUNTIME_CONTROL_SECRET)
    || csv(env.BAIRUI_RUNTIME_ALLOWED_CIDRS).some(value => !preciseRange(value))
    || csv(env.BAIRUI_RUNTIME_ALLOWED_HOSTS).some(value => /[\s\/*?#@]/.test(value))
    || !new RemoteRuntimeDriver({ env }).canRun().ok) throw new Error('runtime_controller_config_invalid');
  return { connectionString, host: '127.0.0.1', port, intervalMs, batchSize, maxAttempts,
    tokenFile: env.BAIRUI_RUNTIME_CONTROLLER_METRICS_TOKEN_FILE };
}
