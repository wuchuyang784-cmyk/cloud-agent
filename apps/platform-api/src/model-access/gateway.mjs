import { createHash, randomUUID } from 'node:crypto';
import { ModelAccessError } from './errors.mjs';
import { openCredential } from './crypto.mjs';
import { validateModelRequest } from './request.mjs';
import { createProviderTransport } from './transport.mjs';
import { forwardModelStream } from './stream.mjs';

const defaults = Object.freeze({ maxBodyBytes: 65536, maxEventBytes: 262144, maxOutputBytes: 4194304, maxConcurrent: 16, timeoutMs: 120000 });
function sendError(response, error) {
  if (response.destroyed || response.writableEnded) return;
  const safe = error instanceof ModelAccessError ? error : new ModelAccessError();
  const body = JSON.stringify({ error: { code: safe.code, message: safe.code } });
  if (response.headersSent) response.end('event: error\ndata: ' + body + '\n\n');
  else { response.writeHead(safe.status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }); response.end(body); }
}
async function readBody(request, maximum, signal) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw new ModelAccessError('model_gateway_timeout');
    size += chunk.length; if (size > maximum) throw new ModelAccessError('model_gateway_limit'); chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { throw new ModelAccessError('invalid_model_input'); }
}
function write(response, value, signal) {
  if (signal.aborted || response.destroyed) return Promise.reject(new ModelAccessError('model_upstream_unavailable'));
  if (response.write(value)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { response.off('drain', drained); response.off('close', closed); response.off('error', closed); signal.removeEventListener('abort', closed); };
    const drained = () => { clean(); resolve(); }, closed = () => { clean(); reject(new ModelAccessError('model_upstream_unavailable')); };
    response.once('drain', drained); response.once('close', closed); response.once('error', closed); signal.addEventListener('abort', closed, { once: true });
    if (signal.aborted || response.destroyed) closed();
  });
}

export function createModelGateway({ store, privateKeys, providers, transport = createProviderTransport(), limits: configured = {} }) {
  const limits = { ...defaults, ...configured };
  for (const [key, value] of Object.entries(limits)) if (!Object.hasOwn(defaults, key) || !Number.isInteger(value) || value < 1 || value > defaults[key]) throw new ModelAccessError('model_access_configuration_invalid');
  if (!store || !privateKeys || !Array.isArray(providers) || !providers.length) throw new ModelAccessError('model_access_configuration_invalid');
  const active = new Set(); let draining = false;
  async function serve(request, response) {
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'GET' && request.url === '/livez') { response.writeHead(draining ? 503 : 200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: draining ? 'draining' : 'ok' })); return; }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404, { connection: 'close' }); response.end(); return; }
    if (draining || active.size >= limits.maxConcurrent) { sendError(response, new ModelAccessError(draining ? 'model_access_unavailable' : 'model_gateway_busy')); return; }
    const controller = new AbortController(), job = { controller }, signal = controller.signal;
    active.add(job); let reserved, upstream, timedOut = false, completed = false;
    const abortReads = () => { upstream?.destroy?.(); if (['shutdown', 'deadline'].includes(signal.reason) && !request.complete) request.destroy(); };
    signal.addEventListener('abort', abortReads, { once: true });
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', disconnect);
    const timer = setTimeout(() => { timedOut = true; sendError(response, new ModelAccessError('model_gateway_timeout')); controller.abort('deadline'); }, limits.timeoutMs);
    job.done = new Promise(resolve => { job.resolve = resolve; });
    try {
      const authCount = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'authorization').length;
      const auth = request.headers.authorization;
      if (authCount !== 1 || typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) throw new ModelAccessError('model_grant_invalid');
      const token = auth.slice(7); if (Buffer.from(token, 'base64url').toString('base64url') !== token) throw new ModelAccessError('model_grant_invalid');
      if (request.headers.origin !== undefined) throw new ModelAccessError('model_access_denied');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') || request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new ModelAccessError('invalid_model_input');
      const payload = validateModelRequest(await readBody(request, limits.maxBodyBytes, signal));
      if (signal.aborted) throw new ModelAccessError('model_gateway_timeout');
      reserved = await store.reserveRequest({ tokenHash: createHash('sha256').update(token).digest('hex'), requestId: randomUUID(), model: payload.model });
      const provider = providers.find(item => item.id === reserved.provider && item.models.includes(payload.model));
      if (!provider) throw new ModelAccessError('model_grant_invalid');
      if (signal.aborted) throw new ModelAccessError('model_gateway_timeout');
      const apiKey = openCredential({ privateKeys, context: reserved.context, envelope: reserved.envelope });
      upstream = await transport({ provider, apiKey, payload, signal });
      if (signal.aborted) { upstream.destroy?.(); throw new ModelAccessError('model_gateway_timeout'); }
      const abortUpstream = () => upstream.destroy?.(); signal.addEventListener('abort', abortUpstream, { once: true });
      try {
        await forwardModelStream(upstream, { secrets: [apiKey, token], signal, limits,
          write: async value => { if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }); await write(response, value, signal); },
          finish: async result => { if (signal.aborted) throw new ModelAccessError('model_gateway_timeout'); await store.finishRequest(reserved.requestId, result); completed = true; },
        });
      } finally { signal.removeEventListener('abort', abortUpstream); }
      response.end();
    } catch (error) {
      controller.abort(); upstream?.destroy?.();
      if (reserved && !completed) { try { await store.finishRequest(reserved.requestId, { state: 'unknown', inputTokens: null, outputTokens: null }); } catch { /* Leave the durable lease/unknown outcome; never replay. */ } }
      sendError(response, timedOut ? new ModelAccessError('model_gateway_timeout') : error instanceof ModelAccessError ? error : new ModelAccessError('model_upstream_unavailable'));
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abortReads); response.off('close', disconnect); active.delete(job); job.resolve(); }
  }
  return { handler: (request, response) => { void serve(request, response).catch(() => sendError(response, new ModelAccessError())); },
    async shutdown() { draining = true; const jobs = [...active]; for (const job of jobs) job.controller.abort('shutdown'); await Promise.allSettled(jobs.map(job => job.done)); } };
}
