import { isIP } from 'node:net';
import { hasSafeDatabaseParameters } from '../runtime/managed-database.mjs';

export function readPublisherConfig(env = process.env) {
  if (env.BAIRUI_ANNOUNCEMENT_PUBLISHER_ENABLED !== '1') throw new Error('announcement_publisher_explicit_enable_required');
  const connectionString = env.BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL;
  let database;
  try { database = new URL(connectionString); } catch { throw new Error('announcement_publisher_config_invalid'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname);
  const tls = env.BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_TLS;
  const intervalMs = Number(env.BAIRUI_ANNOUNCEMENT_PUBLISHER_INTERVAL_MS ?? 5000);
  const limit = Number(env.BAIRUI_ANNOUNCEMENT_PUBLISHER_BATCH_SIZE ?? 50);
  const port = Number(env.BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_PORT ?? 9496);
  const host = env.BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_HOST ?? '127.0.0.1';
  const tokenFile = env.BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_TOKEN_FILE;
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.username || !database.password
    || decodeURIComponent(database.username) === 'postgres' || database.pathname.length < 2 || database.hash
    || !hasSafeDatabaseParameters(database) || connectionString === env.DATABASE_URL
    || (tls !== undefined && !['0', '1'].includes(tls)) || (!local && tls !== '1')
    || !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60000
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
    || !isIP(host) || !Number.isSafeInteger(port) || port < 1024 || port > 65535
    || typeof tokenFile !== 'string' || !tokenFile.trim() || tokenFile.length > 4096
    || (env.BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_CA_FILE && tls !== '1')) throw new Error('announcement_publisher_config_invalid');
  return { connectionString, intervalMs, limit, port, host, tokenFile,
    ssl: tls === '1' ? { rejectUnauthorized: true } : false,
    caFile: env.BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_CA_FILE };
}
