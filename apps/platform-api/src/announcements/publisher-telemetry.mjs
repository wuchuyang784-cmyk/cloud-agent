import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Gauge, Counter, Registry } from 'prom-client';

const digest = value => createHash('sha256').update(value).digest();
const names = ['processed', 'published', 'expired', 'blocked', 'failed', 'pending', 'maxDelaySeconds', 'blockedTotal'];
export function createPublisherTelemetry({ token, host = '127.0.0.1', port = 0 } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]{32,256}={0,2}$/.test(token) || token.length > 256
    || new Set(token).size < 8 || /^(.{1,16})\1+$/.test(token)) throw new Error('announcement_publisher_token_invalid');
  if (!isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('announcement_publisher_metrics_address_invalid');
  const registry = new Registry(), expected = digest(token), registers = [registry];
  const gauge = (name, help) => new Gauge({ name: 'bairui_announcement_publisher_' + name, help, registers });
  const cycle = gauge('cycle_ok', 'Whether the last complete publisher cycle succeeded.'); cycle.set(0);
  const failures = new Counter({ name: 'bairui_announcement_publisher_failures_total', help: 'Failed publisher cycles or individual items.', registers });
  const published = new Counter({ name: 'bairui_announcement_publisher_published_total', help: 'Publications confirmed by this process (not an exactly-once global total).', registers });
  let values, lastSuccess, starting, closing, stopped = false;
  const server = createServer({ headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1000,
    connectionsCheckingInterval: 1000, maxHeaderSize: 8192 }, async (request, response) => {
    request.on('error', () => {});
    const send = (status, body = '') => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { 'cache-control': 'no-store', connection: 'close',
        ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}), ...(status === 200 ? { 'content-type': registry.contentType } : {}) });
      request.resume(); response.end(body);
    };
    const headers = request.headersDistinct.authorization ?? [];
    const match = headers.length === 1 && headers[0].length <= 263 && /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(headers[0]);
    if (!match || !timingSafeEqual(expected, digest(match[1]))) return send(401);
    if (request.method !== 'GET' || request.url !== '/metrics') return send(404);
    try { send(200, await registry.metrics()); } catch { send(503); }
  });
  server.setTimeout(5000, socket => socket.destroy()); server.maxConnections = 32;
  return { server, registry,
    start() {
      if (stopped) return Promise.reject(new Error('announcement_publisher_metrics_closed'));
      starting ??= new Promise((resolve, reject) => {
        const error = cause => { server.off('listening', listening); reject(cause); };
        const listening = () => { server.off('error', error); resolve(server.address()); };
        server.once('error', error); server.once('listening', listening); server.listen(port, host);
      }); return starting;
    },
    close() {
      stopped = true; closing ??= (async () => {
        await starting?.catch(() => {}); if (!server.listening) return;
        await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
      })(); return closing;
    },
    update({ ok, snapshot } = {}) {
      cycle.set(0);
      if (ok === false) { failures.inc(); return; }
      if (ok !== true || !snapshot || names.some(name => !Number.isFinite(snapshot[name]) || snapshot[name] < 0
        || (name !== 'maxDelaySeconds' && !Number.isSafeInteger(snapshot[name])))) throw new Error('announcement_publisher_snapshot_invalid');
      values ??= { pending: gauge('pending', 'Due, unblocked scheduled announcements including retry backoff.'),
        maxDelaySeconds: gauge('max_delay_seconds', 'Oldest due unblocked schedule delay in seconds.'),
        blockedTotal: gauge('blocked', 'Schedules requiring an active administrator to cancel and reconfirm.') };
      lastSuccess ??= gauge('last_success_timestamp_seconds', 'Unix time of the last complete successful publisher cycle.');
      for (const key of Object.keys(values)) values[key].set(snapshot[key]);
      failures.inc(snapshot.failed); published.inc(snapshot.published); lastSuccess.set(Date.now() / 1000); cycle.set(1);
    },
  };
}
