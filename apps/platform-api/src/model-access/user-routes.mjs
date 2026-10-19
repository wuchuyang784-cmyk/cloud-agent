import { createCredentialService } from './service.mjs';
import { PostgresModelAccessStore } from './postgres-store.mjs';
import { ModelAccessError } from './errors.mjs';
import { assertExact, isUuid } from './validation.mjs';

export const isModelCredentialPath = path => /^\/api\/user\/model-credentials(?:\/|$)/.test(path);
const metadata = ({ id, provider, label, version, status, createdAt, updatedAt }) => ({ id, provider, label, version, status, createdAt, updatedAt });
const failure = code => new ModelAccessError(code);

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, finished = false;
    const finish = (error, input) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      request.off('data', data); request.off('end', end); request.off('error', aborted); request.off('aborted', aborted);
      if (error) { request.on('error', () => {}); request.pause(); reject(error); } else resolve(input);
    };
    const data = chunk => { size += chunk.length; if (size > 8192) finish(new Error('payload_too_large')); else chunks.push(chunk); };
    const end = () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new Error('invalid_json')); } };
    const aborted = () => finish(new Error('invalid_json'));
    const timer = setTimeout(() => finish(new Error('request_timeout')), 10000);
    request.on('data', data); request.once('end', end); request.once('error', aborted); request.once('aborted', aborted);
  });
}

function closeAfterResponse(request, response) {
  const socket = request.socket;
  response.shouldKeepAlive = false;
  response.setHeader('connection', 'close');
  // Flush the small fixed error response before terminating an incomplete upload.
  // A peer that refuses to finish its half of the connection gets no open socket
  // beyond this bounded grace period.
  response.once('finish', () => {
    if (socket.destroyed) return;
    socket.end();
    const timer = setTimeout(() => socket.destroy(), 1000);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  });
}

// API credentials use only the existing application pool and the encryption public
// key. Issuance/decryption/gateway methods have no browser route here.
export function createModelCredentialHandler({ env, configuration, platformStore, authProvider, mode, injectedStore }) {
  if (!configuration) return null;
  if (env.NODE_ENV !== 'test' && (authProvider !== 'better-auth' || mode !== 'platform' || !platformStore.pool)) throw failure('model_access_configuration_invalid');
  const store = injectedStore ?? new PostgresModelAccessStore({ pool: platformStore.pool });
  const service = createCredentialService({ store, configuration });
  let origin;
  try { const url = new URL(env.BETTER_AUTH_URL); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error(); origin = url.origin; }
  catch { throw failure('model_access_configuration_invalid'); }
  let active = 0;
  const actors = new Map();
  return async function handleModelCredentials({ request, response, url, principal, scope, sendJson, sendError, requestId }) {
    const fail = (status, code) => sendError(response, status, code, code, requestId);
    response.setHeader('cache-control', 'no-store');
    const match = url.pathname.match(/^\/api\/user\/model-credentials(?:\/([^/]+))?$/);
    if (!match || (match[1] && !isUuid(match[1]))) return fail(404, 'not_found');
    const id = match[1], write = request.method !== 'GET';
    const allowed = id ? ['PUT', 'DELETE'] : ['GET', 'POST'];
    if (!allowed.includes(request.method)) { response.setHeader('allow', allowed.join(', ')); return fail(405, 'method_not_allowed'); }
    if (url.search) return fail(422, 'invalid_model_input');
    if (principal.accountStatus === 'banned') return fail(401, 'account_banned');
    if (write && principal.accountStatus === 'suspended') return fail(403, 'account_suspended');
    if (write) {
      if (request.headers.origin !== origin) return fail(403, 'origin_rejected');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return fail(415, 'json_required');
      if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') return fail(415, 'encoding_rejected');
    }
    const now = Date.now();
    for (const [key, value] of actors) if (value.until <= now) actors.delete(key);
    const actor = JSON.stringify([scope.organizationId, scope.userId]);
    let budget = actors.get(actor);
    if (active >= 16 || (!budget && actors.size >= 4096) || budget?.count >= 120) {
      response.setHeader('retry-after', '1'); return fail(429, 'model_gateway_busy');
    }
    if (!budget) { budget = { count: 0, until: now + 60000 }; actors.set(actor, budget); }
    budget.count++; active++;
    let operation;
    try {
      let input;
      if (write) {
        try { input = await readBody(request); }
        catch (error) {
          closeAfterResponse(request, response);
          return fail(error.message === 'payload_too_large' ? 413 : error.message === 'request_timeout' ? 408 : 400, error.message);
        }
      }
      if (request.method === 'DELETE') assertExact(input, ['expectedVersion']);
      operation = Promise.resolve().then(() => request.method === 'GET' ? service.list(scope)
        : request.method === 'POST' ? service.create(scope, input)
          : request.method === 'PUT' ? service.rotate(scope, id, input) : service.revoke(scope, id, input.expectedVersion));
      // Keep a slot until the database operation actually settles, even if the
      // response deadline expires. A stuck pool cannot admit unbounded work.
      operation.then(() => { active--; }, () => { active--; });
      let timer;
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(failure('model_access_unavailable')), 5000); });
      let value;
      try { value = await Promise.race([operation, timeout]); } finally { clearTimeout(timer); }
      return sendJson(response, request.method === 'POST' ? 201 : 200,
        request.method === 'GET' ? { credentials: value.slice(0, 50).map(metadata) } : { credential: metadata(value) });
    } catch (error) {
      const safe = error instanceof ModelAccessError && ['invalid_model_input', 'model_credential_not_found', 'model_access_conflict', 'model_access_denied'].includes(error.code) ? error : failure('model_access_unavailable');
      return fail(safe.status, safe.code);
    } finally { if (!operation) active--; }
  };
}
