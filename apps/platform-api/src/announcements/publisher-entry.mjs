// Explicit service entry. Never load business .env or start any Agent/Worker.
import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { readPublisherConfig } from './publisher-config.mjs';
import { createPublisherTelemetry } from './publisher-telemetry.mjs';
import { startPublisherLoop } from './publisher.mjs';

export async function readPublisherToken(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 258) throw new Error();
    const buffer = Buffer.alloc(259); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const token = buffer.subarray(0, bytesRead).toString('utf8').replace(/\r?\n$/, '');
    if (!/^[A-Za-z0-9._~+/-]{32,256}={0,2}$/.test(token) || token.length > 256
      || new Set(token).size < 8 || /^(.{1,16})\1+$/.test(token)) throw new Error();
    return token;
  } catch { throw new Error('announcement_publisher_token_invalid'); }
  finally { await handle?.close(); }
}

export async function startPublisher(env = process.env, { check = false, once = false } = {}) {
  const config = readPublisherConfig(env);
  if (config.caFile) config.ssl.ca = await readFile(config.caFile);
  const token = await readPublisherToken(config.tokenFile);
  const pool = new pg.Pool({ connectionString: config.connectionString, ssl: config.ssl, max: 1,
    connectionTimeoutMillis: 2000, statement_timeout: 10000, query_timeout: 12000, keepAlive: true });
  pool.on('error', () => console.error('announcement_publisher_database_unavailable'));
  let telemetry, loop, closing;
  try {
    const role = (await pool.query(`SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
      has_function_privilege(current_user,'platform_announcement_publisher_tick(integer)','EXECUTE') can_tick,
      has_function_privilege(current_user,'platform_announcement_publisher_status()','EXECUTE') can_status,
      has_function_privilege(current_user,'platform_announcement_change(text,jsonb)','EXECUTE') can_change,
      EXISTS(SELECT 1 FROM unnest(ARRAY['platform_announcements','platform_announcement_audit','platform_announcement_receipts',
        'platform_announcement_requests','users','platform_role_bindings','platform_account_governance','user_notifications']) t
        WHERE has_table_privilege(current_user,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) direct_access
      FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (!role || role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.rolcreatedb || role.rolreplication
      || role.direct_access || role.can_change || !role.can_tick || !role.can_status) throw new Error('announcement_publisher_role_invalid');
    const status = (await pool.query('SELECT platform_announcement_publisher_status() AS result')).rows[0].result;
    if (check) { await pool.end(); return { status, close: async () => {} }; }
    const { publisherTick } = await import('./publisher-store.mjs');
    if (once) { const result = await publisherTick({ pool }, { limit: config.limit }); await pool.end(); return { result, close: async () => {} }; }
    telemetry = createPublisherTelemetry({ token, host: config.host, port: config.port }); await telemetry.start();
    loop = startPublisherLoop({ intervalMs: config.intervalMs, maxBackoffMs: 60000, telemetry,
      cycle: () => publisherTick({ pool }, { limit: config.limit }), onError: code => console.error(code) });
    return { server: telemetry.server, close() {
      closing ??= (async () => { await loop.close(); await telemetry.close(); await pool.end(); })(); return closing;
    } };
  } catch (error) { await loop?.close(); await telemetry?.close(); await pool.end(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => !['--check', '--once'].includes(arg))) throw new Error('invalid_arguments');
    const service = await startPublisher(process.env, { check: args.includes('--check'), once: args.includes('--once') });
    if (args.length) console.log(args[0] === '--check' ? 'announcement_publisher_check_ok' : 'announcement_publisher_once_ok');
    else {
      console.log('announcement_publisher_ready');
      const stop = () => { void service.close().catch(() => { console.error('announcement_publisher_shutdown_failed'); process.exitCode = 1; }); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }
  } catch { console.error('announcement_publisher_start_failed'); process.exitCode = 1; }
}
