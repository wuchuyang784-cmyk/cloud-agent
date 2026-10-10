import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Gauge, Registry } from 'prom-client';

const digest = value => createHash('sha256').update(value).digest();
const fields = Object.freeze({ active: 'active', stopping: 'stopping', stopOverdue: 'stop_overdue',
  deadPending: 'dead_pending', observationErrors: 'observation_errors', observationStale: 'observation_stale' });

export function createRuntimeTelemetry({ token, host = '127.0.0.1', port = 0 } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]{32,256}={0,2}$/.test(token)
    || token.length > 256 || new Set(token).size < 8 || /^(.{1,16})\1+$/.test(token)) throw new Error('runtime_metrics_token_invalid');
  if (!isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('runtime_metrics_address_invalid');
  const expected = digest(token);
  const registry = new Registry();
  const gauge = (name, help) => new Gauge({ name: 'bairui_runtime_' + name, help, registers: [registry] });
  const cycle = gauge('controller_cycle_ok', 'Whether the last complete controller cycle succeeded.');
  cycle.set(0);
  let values, lastSuccess, starting, closing, stopped = false;
  const server = createServer({ headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1000,
    connectionsCheckingInterval: 1000, maxHeaderSize: 8192 }, async (request, response) => {
    request.on('error', () => {});
    const send = (status, body = '') => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'cache-control': 'no-store', connection: 'close',
        ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
        ...(status === 200 ? { 'content-type': registry.contentType } : {}) });
      request.resume(); response.end(body);
    };
    const headers = request.headersDistinct.authorization ?? [];
    const match = headers.length === 1 && headers[0].length <= 263 && /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(headers[0]);
    if (!match || !timingSafeEqual(expected, digest(match[1]))) return send(401);
    if (request.method !== 'GET' || request.url !== '/metrics') return send(404);
    const timeout = setTimeout(() => { send(503); response.destroy(); }, 5000);
    timeout.unref();
    try { send(200, await registry.metrics()); } catch { send(503); }
    finally { clearTimeout(timeout); }
  });
  server.setTimeout(5000, socket => socket.destroy());
  server.maxConnections = 32;
  return {
    server,
    start() {
      if (stopped) return Promise.reject(new Error('runtime_metrics_closed'));
      starting ??= new Promise((resolve, reject) => {
        const error = cause => { server.off('listening', listening); reject(cause); };
        const listening = () => { server.off('error', error); resolve(server.address()); };
        server.once('error', error); server.once('listening', listening); server.listen(port, host);
      });
      return starting;
    },
    close() {
      stopped = true;
      closing ??= (async () => {
        await starting?.catch(() => {});
        if (!server.listening) return;
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      })();
      return closing;
    },
    update({ ok, snapshot } = {}) {
      cycle.set(0);
      if (ok === false) return;
      if (ok !== true || !snapshot || Object.keys(fields).some(key => !Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0)) {
        throw new Error('runtime_metrics_snapshot_invalid');
      }
      // Create these gauges only after a complete observation; zero is real data.
      values ??= Object.fromEntries(Object.entries(fields).map(([key, name]) => [key, gauge(name, `Last successful snapshot: ${name}.`)]));
      lastSuccess ??= gauge('controller_last_success_timestamp_seconds', 'Unix time of the last complete successful controller cycle.');
      for (const key of Object.keys(fields)) values[key].set(snapshot[key]);
      lastSuccess.set(Date.now() / 1000);
      cycle.set(1);
    },
  };
}
