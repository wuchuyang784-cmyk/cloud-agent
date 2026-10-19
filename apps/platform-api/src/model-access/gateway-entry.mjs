import { createServer } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { readGatewayConfiguration } from './config.mjs';
import { PostgresModelAccessStore } from './postgres-store.mjs';
import { createModelGateway } from './gateway.mjs';
import { ModelAccessError } from './errors.mjs';

// Verify the effective dedicated login, not merely a role name in a config.
export async function verifyGatewayDatabase(pool) {
  try {
    const { rows } = await pool.query(`SELECT
      r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication AS privileged,
      current_user <> session_user AS switched,
      has_schema_privilege(current_schema(),'CREATE') AS schema_write,
      EXISTS(SELECT 1 FROM unnest(ARRAY['model_credentials','model_runtime_grants','model_gateway_requests','model_access_audit']) t
        WHERE has_table_privilege(current_user,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS table_access,
      has_function_privilege(current_user,'model_request_reserve(text,uuid,text)','EXECUTE')
        AND has_function_privilege(current_user,'model_request_finish(uuid,text,bigint,bigint)','EXECUTE') AS gateway_allowed,
      EXISTS(SELECT 1 FROM unnest(ARRAY['model_credential_list(text,text)','model_credential_get(text,text,uuid)','model_credential_create(text,text,jsonb)',
        'model_credential_rotate(text,text,uuid,integer,jsonb)','model_credential_revoke(text,text,uuid,integer)',
        'model_grant_issue(text,text,jsonb)','model_grant_revoke(uuid)','model_actor(text,text,boolean)',
        'model_runtime_valid(text,text,text,text,bigint,integer,boolean)','model_envelope_valid(jsonb)']) f
        WHERE has_function_privilege(current_user,f,'EXECUTE')) AS extra_functions
      FROM pg_roles r WHERE r.rolname=current_user`);
    const row = rows[0];
    if (!row || row.privileged || row.switched || row.schema_write || row.table_access || !row.gateway_allowed || row.extra_functions) throw new Error();
  } catch { throw new ModelAccessError('model_access_configuration_invalid'); }
}

export async function startModelGateway({ env = process.env } = {}) {
  const config = await readGatewayConfiguration(env);
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 2000, query_timeout: 4500, idleTimeoutMillis: 10000,
    statement_timeout: 3000, lock_timeout: 1000, application_name: 'bairui-model-gateway' });
  pool.on('error', () => { console.error('model_gateway_database_unavailable'); });
  let server, gateway;
  try {
    await verifyGatewayDatabase(pool);
    gateway = createModelGateway({ store: new PostgresModelAccessStore({ pool }), privateKeys: config.privateKeys, providers: config.providers });
    server = createServer({ key: config.tlsKey, cert: config.tlsCert, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, gateway.handler);
    server.headersTimeout = 10000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000; server.timeout = 130000;
    server.maxHeadersCount = 32; server.maxConnections = 64;
    await new Promise((yes, no) => { server.once('error', no); server.listen(config.port, config.host, () => { server.off('error', no); yes(); }); });
    server.on('error', () => { console.error('model_gateway_listener_failed'); });
    let stopped;
    return { server, async stop() {
      stopped ??= (async () => {
        const closed = new Promise(resolveClose => server.close(resolveClose));
        await gateway.shutdown(); server.closeAllConnections(); await closed; await pool.end();
      })();
      return stopped;
    } };
  } catch {
    if (gateway) await gateway.shutdown(); server?.closeAllConnections(); if (server?.listening) await new Promise(done => server.close(done)); await pool.end();
    throw new ModelAccessError('model_access_configuration_invalid');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error();
    const service = await startModelGateway(); console.log('model_gateway_ready');
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; service.stop().catch(() => { console.error('model_gateway_stop_failed'); process.exitCode = 1; }); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch { console.error('model_gateway_start_failed'); process.exitCode = 1; }
}
