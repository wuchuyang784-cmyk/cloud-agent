import { emailAddress } from './email-delivery.mjs';
import { isMailToken } from './email-challenges.mjs';

const routes = new Map([
  ['/api/auth/email-verification/request', { kind: 'verify', action: 'request', keys: [], limit: 8 }],
  ['/api/auth/email-verification/confirm', { kind: 'verify', action: 'confirm', keys: ['token'], limit: 15 }],
  ['/api/auth/password-reset/request', { kind: 'reset', action: 'request', keys: ['email'], limit: 8 }],
  ['/api/auth/password-reset/confirm', { kind: 'reset', action: 'confirm', keys: ['token', 'newPassword'], limit: 15 }],
]);
export const isEmailAuthRoute = path => routes.has(path);

export function authJson(response, status, value, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

export function authError(response, status, code, headers) {
  authJson(response, status, { error: { code, message: code } }, headers);
}

export function readAuthBody(request, maxBytes, deadlineMs = 10000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => finish('request_timeout'), deadlineMs);
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) finish('payload_too_large');
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish('invalid_request');
    function finish(code) {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onError);
      if (code) {
        request.pause();
        reject(new Error(code));
      } else resolve(Buffer.concat(chunks));
    }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onError);
  });
}

export function parseAuthJson(body) {
  try {
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  } catch { /* Invalid input gets a fixed response. */ }
  return null;
}

export async function handleEmailAuth(resolver, request, response, path, maxBytes) {
  const route = routes.get(path);
  if (request.method !== 'POST' || request.url !== path || resolver.emailMode === 'off'
    || (path === '/api/auth/email-verification/request' && resolver.emailMode !== 'transition')) {
    return authError(response, 404, 'not_found');
  }
  if (request.headers.origin !== resolver.baseURL) return authError(response, 403, 'origin_rejected');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
    return authError(response, 415, 'unsupported_media_type');
  }
  let raw;
  try { raw = await readAuthBody(request, Math.min(maxBytes, 2048)); }
  catch (error) {
    return authError(response, error.message === 'request_timeout' ? 408 : error.message === 'payload_too_large' ? 413 : 400,
      error.message, { connection: 'close' });
  }
  const input = parseAuthJson(raw);
  if (!input || Object.keys(input).length !== route.keys.length || !route.keys.every(key => Object.hasOwn(input, key))) {
    return authError(response, 400, 'invalid_request');
  }
  if (!await resolver.email.limit(path, resolver.rateLimitPeer(request), route.limit)) {
    return authError(response, 429, 'too_many_requests', { 'retry-after': '60' });
  }
  if (route.action === 'request') {
    if (route.kind === 'verify') {
      const session = await resolver.session(request);
      if (!session) return authError(response, 401, 'unauthenticated');
      const expectedUser = request.headers['x-bairui-expected-user'];
      if (expectedUser !== undefined && (typeof expectedUser !== 'string'
        || expectedUser !== (await resolver.principalForSession(session)).userId)) {
        return authError(response, 409, 'account_changed');
      }
      resolver.enqueueEmail({ kind: 'verify', authId: session.user.id });
    } else {
      if (!emailAddress(input.email)) return authError(response, 400, 'invalid_request');
      resolver.enqueueEmail({ kind: 'reset', email: input.email.toLowerCase() });
    }
    return authJson(response, 202, { accepted: true });
  }
  if (!isMailToken(input.token)) return authError(response, 400, 'invalid_or_expired_link');
  if (route.kind === 'reset' && (typeof input.newPassword !== 'string'
    || input.newPassword.length < 12 || input.newPassword.length > 128)) {
    return authError(response, 400, 'invalid_password');
  }
  if (!await resolver.email.confirm(route.kind, input.token, input.newPassword)) {
    return authError(response, 400, 'invalid_or_expired_link');
  }
  return authJson(response, 200, { ok: true });
}
