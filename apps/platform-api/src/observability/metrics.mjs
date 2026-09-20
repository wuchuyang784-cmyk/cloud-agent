import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { createReadiness } from '../service-lifecycle.mjs';
import { methodLabel, routeLabel, statusLabel } from './labels.mjs';
import { safeLog } from './safe-log.mjs';

const digest = token => createHash('sha256').update(token).digest();

export function metricsConfiguration(env) {
  if (env.BAIRUI_METRICS_ENABLED !== '1') return { enabled: false };
  const port = Number(env.BAIRUI_METRICS_PORT ?? 9464);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('metrics_port_invalid');
  let fd, text;
  try {
    fd = openSync(env.BAIRUI_METRICS_TOKEN_FILE ?? '/run/secrets/metrics-token', 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 258) throw new Error('metrics_token_invalid');
    const buffer = Buffer.alloc(259);
    text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
  } catch (error) {
    throw new Error(error.message === 'metrics_token_invalid' ? 'metrics_token_invalid' : 'metrics_token_unavailable');
  } finally { if (fd !== undefined) closeSync(fd); }
  const token = text.replace(/\r?\n$/, '');
  if (!/^[A-Za-z0-9._~+/-]{32,256}={0,2}$/.test(token) || token.length > 256
    || new Set(token).size < 8 || /^(.{1,16})\1+$/.test(token)) throw new Error('metrics_token_invalid');
  return { enabled: true, port, tokenHash: digest(token) };
}

function authorized(request, tokenHash) {
  let headers = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === 'authorization') headers++;
  }
  const header = request.headers.authorization;
  if (headers !== 1 || typeof header !== 'string' || header.length > 263) return false;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
  return Boolean(match && timingSafeEqual(digest(match[1]), tokenHash));
}

function poolNumber(read) {
  try {
    const value = read();
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch { return 0; }
}

export function createTelemetry(config, store, { readinessTimeoutMs = 250 } = {}) {
  if (!config.enabled) return { enabled: false, registry: null, server: null,
    async start() {}, async close() {}, observeRequest() {} };
  if (!Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 1 || readinessTimeoutMs > 1000) {
    throw new Error('metrics_readiness_timeout_invalid');
  }
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const registers = [registry];
  const labelNames = ['method', 'route', 'status'];
  const requests = new Counter({ name: 'bairui_http_requests_total', help: 'Completed API requests, including client aborts (499).', labelNames, registers });
  const duration = new Histogram({ name: 'bairui_http_request_duration_seconds', help: 'API request duration in seconds.', labelNames,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers });
  const inFlight = new Gauge({ name: 'bairui_http_requests_in_flight', help: 'API requests awaiting completion.', registers });
  const ready = createReadiness({ ping: () => {
    if (typeof store.ping !== 'function') throw new Error('database_probe_unavailable');
    return store.ping();
  } }, readinessTimeoutMs);
  new Gauge({ name: 'bairui_database_ready', help: 'Whether the bounded database probe succeeded.', registers,
    async collect() { this.set(await ready() ? 1 : 0); } });
  new Gauge({ name: 'bairui_db_pool_connections', help: 'Database pool connection counts.', labelNames: ['state'], registers,
    collect() {
      for (const [state, property] of [['total', 'totalCount'], ['idle', 'idleCount'], ['waiting', 'waitingCount']]) {
        this.set({ state }, poolNumber(() => store.pool?.[property]));
      }
    } });
  new Gauge({ name: 'bairui_db_pool_max', help: 'Configured database pool maximum connections.', registers,
    collect() { this.set(poolNumber(() => store.pool?.options?.max)); } });

  let stopped = false, starting, closing;
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1000 }, async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (!authorized(request, config.tokenHash)) {
      response.writeHead(401, { 'www-authenticate': 'Bearer' });
      response.end('Unauthorized');
      return;
    }
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    try {
      const text = await registry.metrics();
      if (response.destroyed) return;
      response.writeHead(200, { 'content-type': registry.contentType });
      response.end(text);
    } catch {
      safeLog('metrics_scrape_error');
      if (!response.destroyed) { response.writeHead(503); response.end('Metrics unavailable'); }
    }
  });
  return {
    enabled: true, port: config.port, server, registry,
    start({ port = config.port, host = '0.0.0.0' } = {}) {
      if (stopped) return Promise.reject(new Error('metrics_closed'));
      if (!starting) starting = new Promise((resolve, reject) => {
        const onError = () => { server.removeListener('listening', onListening); reject(new Error('metrics_listen_failed')); };
        const onListening = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return starting;
    },
    close() {
      stopped = true;
      if (!closing) closing = (async () => {
        if (starting) await starting.catch(() => {});
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      })();
      return closing;
    },
    observeRequest(request, response) {
      const labels = { method: methodLabel(request.method), route: routeLabel(request.url) };
      const began = process.hrtime.bigint();
      let finished = false;
      inFlight.inc();
      const finish = () => {
        if (finished) return;
        finished = true;
        const status = response.writableFinished ? statusLabel(response.statusCode) : '499';
        requests.inc({ ...labels, status });
        duration.observe({ ...labels, status }, Number(process.hrtime.bigint() - began) / 1e9);
        inFlight.dec();
        request.removeListener('aborted', finish);
        response.removeListener('finish', finish);
        response.removeListener('close', finish);
      };
      request.once('aborted', finish);
      response.once('finish', finish);
      response.once('close', finish);
    },
  };
}
