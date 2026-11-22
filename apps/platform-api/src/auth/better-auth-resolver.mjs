import { AsyncLocalStorage } from 'node:async_hooks';
import { betterAuth } from 'better-auth';
import { APIError, getIP } from 'better-auth/api';
import { sessionAllowed } from '../admin/governance.mjs';
import { fromNodeHeaders } from 'better-auth/node';
import { createClientIPResolver } from './client-ip.mjs';
import { authPostgresDatabase, authTransactionDatabase } from './postgres-database.mjs';
import { safeLog } from '../observability/safe-log.mjs';
import { authEmailMode, createEmailQueue, createResendSender, readMailConfig } from './email-delivery.mjs';
import { authTransaction, emailChallenges, lockAuthIdentity } from './email-challenges.mjs';
import { authError, handleEmailAuth, isEmailAuthRoute, parseAuthJson } from './email-routes.mjs';

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
    this.emailMode = authEmailMode(env);
    if (options.emailSender !== undefined && (env.NODE_ENV !== 'test' || typeof options.emailSender !== 'function')) {
      throw new Error('auth_email_configuration_invalid');
    }
    this.mailContext = new AsyncLocalStorage();
    if (this.emailMode !== 'off') {
      if (!store.pool) throw new Error('auth_email_configuration_invalid');
      const send = options.emailSender ?? createResendSender(readMailConfig(env));
      this.email = emailChallenges(store.pool, this.baseURL, config.secret);
      this.pendingSignins = 0;
      this.maxPendingSignins = Math.max(1, Math.min(8, Math.floor((store.pool.options?.max ?? 20) / 2)));
      this.enqueueEmail = createEmailQueue(async job => {
        const message = await this.email.issue(job);
        if (message) await send(message);
      });
      if (this.emailMode === 'enforce') {
        config.emailAndPassword.requireEmailVerification = true;
        config.emailVerification = {
          sendOnSignUp: true, sendOnSignIn: false, autoSignInAfterVerification: false,
          // The native JWT is never sent or exposed. Capture the new identity
          // only; deliver our single-use challenge after signup commits.
          sendVerificationEmail: async ({ user }) => {
            const capture = this.mailContext.getStore();
            if (capture) capture.signupId = user.id;
          },
        };
      }
    }
    config.databaseHooks = { session: { create: { before: async (session, context) => {
      // Sign-up holds an auth transaction; its session INSERT uses the SQL guard on that connection.
      if (store.pool && context?.path === '/sign-up/email') return;
      const transaction = this.mailContext.getStore();
      const client = transaction?.client;
      if (client && transaction.authId !== session.userId) {
        throw new APIError('UNAUTHORIZED', { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' });
      }
      const allowed = client
        ? (await client.query('SELECT platform_account_session_allowed($1) AS allowed', [session.userId])).rows[0]?.allowed
        : await sessionAllowed(store, session.userId);
      if (!allowed) throw new APIError('FORBIDDEN', { code: 'account_banned', message: 'Account access is restricted' });
    } } } };
    this.config = config;
    this.auth = betterAuth(config);
    if (!store.pool) store.governanceRevokeSessions = async userId => {
      const subject = store.users.get(userId)?.authSubject;
      if (subject?.startsWith('better-auth:')) await (await this.auth.$context).internalAdapter.deleteUserSessions(subject.slice('better-auth:'.length));
    };
  }

  async session(request) {
    return this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      query: { disableCookieCache: true, disableRefresh: true },
    });
  }

  rateLimitPeer(request) {
    // Preserve Better Auth's IPv4-mapped and IPv6 /64 bucket semantics.
    // This header is set exclusively from the validated TCP/proxy chain.
    const headers = new Headers({ 'x-bairui-peer-ip': this.clientIP(request) });
    const peer = getIP(headers, this.config);
    if (!peer) throw new Error('invalid_client_ip');
    return peer;
  }

  async resolve(request) {
    const session = await this.session(request);
    if (!session || (this.emailMode === 'enforce' && session.user.emailVerified !== true)) return null;
    return this.principalForSession(session);
  }

  async principalForSession(session) {
    const user = await this.store.ensureIdentityUser({
      subject: 'better-auth:' + session.user.id,
      email: session.user.email,
      displayName: session.user.name,
    });
    const organizations = await this.store.listUserOrganizations(user.id);
    const active = organizations.find(item => item.id === user.organizationId);
    if (!active) throw new Error('identity_membership_missing');
    return { userId: user.id, email: user.email, emailVerified: session.user.emailVerified === true,
      organizationId: active.id, role: active.role, organizations };
  }

  async handleEmailSignin(makeRequest, email, peer) {
    const limited = seconds => new Response(JSON.stringify({ error: { code: 'too_many_requests', message: 'Too many requests' } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(seconds) } });
    if (this.pendingSignins >= this.maxPendingSignins) return limited(1);
    this.pendingSignins++;
    try {
      // Keep the pinned native 3 / 10s sign-in rule, but make admission
      // atomic across replicas and complete it before borrowing a locked
      // credential transaction. A first-row conflict must not abort login.
      if (!await this.email.limit('/api/auth/sign-in/email', peer, 3, 10000)) return limited(10);
      return await this.signinWithIdentityLock(makeRequest, email);
    } finally { this.pendingSignins--; }
  }

  async signinWithIdentityLock(makeRequest, email) {
    let verificationId;
    const result = await authTransaction(this.store.pool, async client => {
      const { rows: [identity] } = await client.query('SELECT id FROM ba_user WHERE email = $1', [email]);
      // Native password timing padding still runs for missing identities.
      // The session hook denies any identity not locked here.
      if (identity) await lockAuthIdentity(client, identity.id);
      const database = authTransactionDatabase(client);
      const attempt = await this.mailContext.run({ client, authId: identity?.id }, () =>
        betterAuth({ ...this.config, database, rateLimit: { ...this.config.rateLimit, enabled: false } }).handler(makeRequest()));
      if (this.emailMode === 'enforce' && attempt.status === 403
        && (await attempt.clone().json().catch(() => null))?.code === 'EMAIL_NOT_VERIFIED') verificationId = identity?.id;
      return attempt;
    });
    if (verificationId) this.enqueueEmail({ kind: 'verify', authId: verificationId });
    return result;
  }

  async handle(request, response, path, maxBodyBytes) {
    if (isEmailAuthRoute(path)) return handleEmailAuth(this, request, response, path, maxBodyBytes);
    const allowed = new Set(['/api/auth/sign-up/email', '/api/auth/sign-in/email', '/api/auth/sign-out']);
    if (request.method !== 'POST' || !allowed.has(path)) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
      return;
    }
    if (path === '/api/auth/sign-up/email' && this.emailMode === 'transition') {
      return authError(response, 403, 'registration_paused');
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
    const body = Buffer.concat(chunks);
    const makeRequest = () => new Request(this.baseURL + path, { method: request.method, headers, body });
    let result;
    if (this.emailMode !== 'off' && path === '/api/auth/sign-in/email') {
      const input = parseAuthJson(body);
      // Better Auth validates the credentials; lookup must match its lowercase
      // normalization so the lock always covers the same authenticated identity.
      if (!input || typeof input.email !== 'string' || input.email.length > 254) return authError(response, 400, 'invalid_request');
      result = await this.handleEmailSignin(makeRequest, input.email.toLowerCase(), this.rateLimitPeer(request));
    } else if (this.emailMode === 'enforce' && path === '/api/auth/sign-up/email') {
      const capture = {};
      result = await this.mailContext.run(capture, () => this.auth.handler(makeRequest()));
      if (result.ok && capture.signupId) this.enqueueEmail({ kind: 'verify', authId: capture.signupId });
    } else result = await this.auth.handler(makeRequest());
    response.statusCode = result.status;
    result.headers.forEach((value, name) => { if (name !== 'set-cookie') response.setHeader(name, value); });
    if (this.emailMode !== 'off') response.setHeader('cache-control', 'no-store');
    const retryAfter = result.headers.get('retry-after') ?? result.headers.get('x-retry-after');
    if (result.status === 429 && retryAfter) response.setHeader('retry-after', retryAfter);
    const cookies = result.headers.getSetCookie();
    if (cookies.length) response.setHeader('set-cookie', cookies);
    response.end(Buffer.from(await result.arrayBuffer()));
  }
}
