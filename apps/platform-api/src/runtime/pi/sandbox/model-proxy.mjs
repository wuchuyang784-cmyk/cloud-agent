import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createSecureContext } from 'node:tls';
import { types } from 'node:util';
import { validateModelRequest } from '../../../model-access/request.mjs';
import { isModelId } from '../../../model-access/validation.mjs';
import { forwardModelStream } from '../../../model-access/stream.mjs';

const defaults = Object.freeze({ maxBodyBytes: 65536, maxEventBytes: 262144, maxOutputBytes: 4194304, timeoutMs: 120000, bodyTimeoutMs: 10000, maxConcurrent: 1 });
const invalid = () => { throw new Error('Invalid sandbox model proxy configuration'); };
const typedArrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get;

// Reject executable configuration before reading values. In particular, even
// reflection on a Proxy may run a trap and leak its arbitrary exception.
function configRecord(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) invalid();
  return result;
}

function copyCA(value) {
  if (typeof value === 'string') {
    if (!value.length || Buffer.byteLength(value) > 262144) invalid();
    return Buffer.from(value);
  }
  if (!value || typeof value !== 'object' || types.isProxy(value) || !types.isUint8Array(value)
    || Object.getPrototypeOf(value) !== Buffer.prototype) invalid();
  const size = typedArrayLength.call(value);
  if (!size || size > 262144) invalid();
  // Accept an ordinary Buffer only. Own getters such as length/buffer/valueOf
  // must not execute in Buffer/TLS conversion, nor can symbols alter copying.
  const keys = Reflect.ownKeys(value);
  if (keys.length !== size) invalid();
  for (const key of keys) {
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= size) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  const result = Buffer.alloc(size);
  Uint8Array.prototype.set.call(result, value);
  return result;
}

function configuration(options) {
  try { return parseConfiguration(options); }
  catch { invalid(); }
}

function parseConfiguration(value) {
  const options = configRecord(value, ['gatewayUrl', 'model', 'token', 'ca', 'limits'], ['gatewayUrl', 'model', 'token']);
  const { gatewayUrl, model, token, ca } = options;
  // Operator-controlled private/internal hostnames are allowed. Reject spelling
  // that WHATWG URL would otherwise silently normalize (dot segments, CRLF, etc.).
  if (typeof gatewayUrl !== 'string' || /[\s\\%\x00-\x1f\x7f]/.test(gatewayUrl)
    || !/^https:\/\/[^@/?#]+\/v1(?:\/|\/chat\/completions)?$/.test(gatewayUrl)) invalid();
  let url;
  try { url = new URL(gatewayUrl); } catch { invalid(); }
  if (url.username || url.password || url.search || url.hash || !url.hostname) invalid();
  url.pathname = '/v1/chat/completions';
  if (!isModelId(model) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)
    || Buffer.from(token, 'base64url').toString('base64url') !== token) invalid();
  let trustedCA;
  if (ca !== undefined) {
    trustedCA = copyCA(ca);
    try { createSecureContext({ ca: trustedCA }); } catch { invalid(); }
  }
  const configured = configRecord(options.limits === undefined ? {} : options.limits, Object.keys(defaults));
  for (const key of Object.keys(configured)) {
    const value = configured[key];
    if (!Object.hasOwn(defaults, key) || !Number.isSafeInteger(value) || value < 1 || value > defaults[key]) invalid();
  }
  return { url, model, token, ca: trustedCA, limits: { ...defaults, ...configured } };
}

class ProxyError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const unavailable = () => new ProxyError(502, 'model_upstream_unavailable');
function sendError(response, error) {
  if (response.destroyed || response.writableEnded) return;
  const safe = error instanceof ProxyError ? error : unavailable();
  const body = JSON.stringify({ error: { code: safe.code, message: safe.code } });
  if (response.headersSent) response.end('event: error\ndata: ' + body + '\n\n');
  else { response.writeHead(safe.status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }); response.end(body); }
}

function readBody(request, maximum, signal) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const clean = () => { request.off('data', data); request.off('end', end); request.off('error', failed); request.off('aborted', failed); signal.removeEventListener('abort', failed); };
    const failed = () => { clean(); request.pause(); reject(unavailable()); };
    const data = chunk => {
      size += chunk.length;
      if (size > maximum) { clean(); request.pause(); reject(new ProxyError(413, 'model_gateway_limit')); }
      else chunks.push(chunk);
    };
    const end = () => {
      clean();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new ProxyError(400, 'invalid_model_input')); }
    };
    request.on('data', data); request.once('end', end); request.once('error', failed); request.once('aborted', failed); signal.addEventListener('abort', failed, { once: true });
    if (signal.aborted) failed();
  });
}

function write(response, value, signal) {
  if (signal.aborted || response.destroyed) return Promise.reject(unavailable());
  if (response.write(value)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { response.off('drain', drained); response.off('close', failed); response.off('error', failed); signal.removeEventListener('abort', failed); };
    const drained = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(unavailable()); };
    response.once('drain', drained); response.once('close', failed); response.once('error', failed); signal.addEventListener('abort', failed, { once: true });
    if (signal.aborted || response.destroyed) failed();
  });
}

/**
 * Trusted control-process bridge, not a browser API. Returns {server, close}.
 * The owned HTTP server is initially unlistened; the caller must bind it only
 * inside the isolated run channel. /v1 and /v1/ bases normalize once to the
 * fixed F2 endpoint. Token and TLS configuration never leave this closure.
 * close() is idempotent, refuses subsequent requests, aborts current work,
 * and closes all owned connections/listener. It never installs a listener.
 */
export function createSandboxModelProxy(options) {
  const { url, model, token, ca, limits } = configuration(options);
  const sockets = new Set(), responses = new WeakMap(); let draining = false, active = null, closing;
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 10000, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 }, (request, response) => {
    void serve(request, response).catch(() => { sendError(response, unavailable()); retire(request, response); });
  });
  server.maxHeadersCount = 32; server.maxConnections = 16; server.maxRequestsPerSocket = 1;
  server.on('connection', socket => {
    sockets.add(socket);
    // Absolute header deadline also covers peers which never finish a header.
    const timer = setTimeout(() => socket.destroy(), 10000); timer.unref();
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
    socket.on('error', () => {});
    socket.headerDeadline = timer;
  });
  server.on('clientError', (error, socket) => {
    if (socket.destroyed) return;
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    // A rejected method/body can trigger a later parser error on this socket.
    // Preserve the already queued fixed response instead of emitting a second.
    if (responses.get(socket)?.headersSent) socket.end();
    else socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
    const timer = setTimeout(() => socket.destroy(), 50); timer.unref();
    socket.once('close', () => clearTimeout(timer));
  });
  server.on('checkContinue', (request, response) => { sendError(response, new ProxyError(400, 'invalid_model_input')); retire(request, response); });

  // A half-written rejected request must not leave an unbounded unread body or
  // half-open socket. Give the fixed error a short opportunity to flush first.
  function retire(request, response) {
    request.pause();
    const socket = request.socket;
    if (socket.destroyed) return;
    const timer = setTimeout(() => socket.destroy(), 50); timer.unref();
    socket.once('close', () => clearTimeout(timer));
    if (request.complete) response.once('finish', () => socket.end());
  }

  async function serve(request, response) {
    responses.set(request.socket, response);
    clearTimeout(request.socket.headerDeadline);
    request.on('error', () => {}); response.on('error', () => {});
    response.setHeader('cache-control', 'no-store'); response.setHeader('connection', 'close');
    const reject = error => { sendError(response, error); retire(request, response); };
    if (draining) return reject(new ProxyError(503, 'model_access_unavailable'));
    // Node truncates the parsed/raw header lists at maxHeadersCount. Reject at
    // that boundary rather than trusting that security headers were retained.
    if (request.rawHeaders.length >= server.maxHeadersCount * 2) return reject(new ProxyError(431, 'invalid_model_input'));
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return reject(new ProxyError(404, 'model_endpoint_not_found'));
    if (active) return reject(new ProxyError(429, 'model_gateway_busy'));
    const controller = new AbortController(), signal = controller.signal;
    const job = { controller, request, response }; active = job;
    job.done = new Promise(resolve => { job.resolve = resolve; });
    let outgoing, upstream, timedOut = false;
    const abort = () => { outgoing?.destroy(); upstream?.destroy(); };
    signal.addEventListener('abort', abort, { once: true });
    const disconnected = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', disconnected);
    const deadline = () => { timedOut = true; reject(new ProxyError(504, 'model_gateway_timeout')); controller.abort(); };
    const timer = setTimeout(deadline, limits.timeoutMs);
    const bodyTimer = setTimeout(deadline, limits.bodyTimeoutMs);
    try {
      if (request.headers.origin !== undefined || request.headers.cookie !== undefined) throw new ProxyError(403, 'model_access_denied');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') || request.headers['content-encoding'] !== undefined) throw new ProxyError(400, 'invalid_model_input');
      const declared = request.headers['content-length'];
      if (declared !== undefined && Number(declared) > limits.maxBodyBytes) throw new ProxyError(413, 'model_gateway_limit');
      const raw = await readBody(request, limits.maxBodyBytes, signal);
      clearTimeout(bodyTimer);
      let payload;
      try { payload = validateModelRequest(raw); } catch { throw new ProxyError(400, 'invalid_model_input'); }
      if (payload.model !== model) throw new ProxyError(403, 'model_access_denied');
      if (signal.aborted) throw unavailable();
      const body = Buffer.from(JSON.stringify(payload));
      upstream = await new Promise((resolve, rejectUpstream) => {
        // No ambient proxy agent, redirects, retries or incoming headers.
        outgoing = httpsRequest(url, { method: 'POST', agent: false, rejectUnauthorized: true, ...(ca ? { ca } : {}), signal,
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': body.length, connection: 'close' } }, resolve);
        outgoing.on('error', () => rejectUpstream(unavailable())); outgoing.end(body);
      });
      if (signal.aborted || upstream.statusCode !== 200 || !/^text\/event-stream(?:\s*;\s*charset=utf-8)?$/i.test(upstream.headers['content-type'] ?? '') || upstream.headers['content-encoding'] !== undefined) throw unavailable();
      await forwardModelStream(upstream, { secrets: [token], signal, limits,
        write: async value => {
          if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
          await write(response, value, signal);
        },
        // F2 already committed the receipt before releasing its terminal frame.
        // This bridge neither records usage/charges nor fabricates a receipt.
        finish: async () => {},
      });
      response.end();
    } catch (error) {
      reject(timedOut ? new ProxyError(504, 'model_gateway_timeout') : error);
      controller.abort();
    } finally {
      clearTimeout(timer); clearTimeout(bodyTimer);
      outgoing?.destroy(); upstream?.destroy();
      signal.removeEventListener('abort', abort); response.off('close', disconnected);
      if (active === job) active = null; job.resolve();
    }
  }

  function close() {
    if (closing) return closing;
    draining = true;
    closing = (async () => {
      const job = active;
      if (job) { sendError(job.response, new ProxyError(503, 'model_access_unavailable')); job.controller.abort(); }
      const stopped = new Promise(resolve => { server.close(() => resolve()); });
      server.closeAllConnections(); for (const socket of sockets) socket.destroy();
      await Promise.all([stopped, job?.done]);
    })();
    return closing;
  }
  return { server, close };
}
