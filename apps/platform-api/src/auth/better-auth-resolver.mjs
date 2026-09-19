import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { createClientIPResolver } from './client-ip.mjs';
import { authPostgresDatabase } from './postgres-database.mjs';
import { safeLog } from '../observability/safe-log.mjs';

export function betterAuthOptions(env, database) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  }
  if (!env.BETTER_AUTH_URL) throw new Error('BETTER_AUTH_URL is required');
  const url = new URL(env.BETTER_AUTH_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('BETTER_AUTH_URL must be an HTTP(S) origin');
  }
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('BETTER_AUTH_URL requires HTTPS in production');
  return {
    database,
    baseURL: url.origin,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [url.origin],
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    user: { modelName: 'ba_user' },
    account: { modelName: 'ba_account', accountLinking: { enabled: false } },
    session: { modelName: 'ba_session', expiresIn: 8 * 60 * 60, disableSessionRefresh: true, cookieCache: { enabled: false } },
    verification: { modelName: 'ba_verification' },
    rateLimit: { enabled: true, storage: 'database', modelName: 'ba_rate_limit', window: 60, max: 60 },
    advanced: {
      useSecureCookies: url.protocol === 'https:',
      ipAddress: { ipAddressHeaders: ['x-bairui-peer-ip'] },
    },
    telemetry: { enabled: false },
    logger: { level: 'warn', disableColors: true, log(level) { safeLog('auth_event', { level }); } },
    // Bypass better-call's raw console fallback; unexpected errors reach the API's safe logger.
    onAPIError: { throw: true },
  };
}

export class BetterAuthPrincipalResolver {
  constructor(store, options = {}) {
    const env = options.env ?? process.env;
    this.clientIP = createClientIPResolver(env);
    this.store = store;
    const config = betterAuthOptions(env, store.pool ? authPostgresDatabase(store.pool) : undefined);
    if (!store.pool && !(env.NODE_ENV === 'test' && options.betterAuthDatabase)) {
      throw new Error('Better Auth requires PostgreSQL; MemoryStore is test-only');
    }
    if (env.NODE_ENV === 'test' && options.betterAuthDatabase) config.database = options.betterAuthDatabase;
    this.provider = 'better-auth';
    this.baseURL = config.baseURL;
    this.auth = betterAuth(config);
  }

  async resolve(request) {
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (!session) return null;
    const user = await this.store.ensureIdentityUser({
      subject: 'better-auth:' + session.user.id,
      email: session.user.email,
      displayName: session.user.name,
    });
    const organizations = await this.store.listUserOrganizations(user.id);
    const active = organizations.find(item => item.id === user.organizationId);
    if (!active) throw new Error('identity_membership_missing');
    return { userId: user.id, email: user.email, organizationId: active.id, role: active.role, organizations };
  }

  async handle(request, response, path, maxBodyBytes) {
    const allowed = new Set(['/api/auth/sign-up/email', '/api/auth/sign-in/email', '/api/auth/sign-out']);
    if (request.method !== 'POST' || !allowed.has(path)) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > Math.min(maxBodyBytes, 16384)) throw new Error('payload_too_large');
      chunks.push(chunk);
    }
    const headers = fromNodeHeaders(request.headers);
    // Only a verified TCP peer and its validated forwarding chain may set this header.
    headers.set('x-bairui-peer-ip', this.clientIP(request));
    const result = await this.auth.handler(new Request(this.baseURL + path, {
      method: request.method, headers, body: Buffer.concat(chunks),
    }));
    response.statusCode = result.status;
    result.headers.forEach((value, name) => { if (name !== 'set-cookie') response.setHeader(name, value); });
    const retryAfter = result.headers.get('retry-after') ?? result.headers.get('x-retry-after');
    if (result.status === 429 && retryAfter) response.setHeader('retry-after', retryAfter);
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader('set-cookie', cookies);
    response.end(Buffer.from(await result.arrayBuffer()));
  }
}
