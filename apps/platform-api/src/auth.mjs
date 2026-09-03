import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const COOKIE_NAME = 'bairui_session';

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('='))
    .filter(([key, value]) => key && value)
    .map(([key, ...value]) => [key, value.join('=')]));
}

export class DevAuth {
  constructor(store, options = {}) {
    this.store = store;
    this.secret = options.secret ?? process.env.BAIRUI_SESSION_SECRET ?? 'local-development-session-secret';
    this.devUser = options.devUser;
  }

  async login(email, password) {
    if (this.devUser && this.store.ensureDevUser) {
      await this.store.ensureDevUser({ ...this.devUser, passwordHash: await hashPassword(this.devUser.password) });
    }
    const user = await this.store.findUserByEmail(email ?? '');
    if (!user || !(await verifyPassword(password ?? '', user.passwordHash ?? user.password))) return null;
    const sessionId = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    await this.store.createAuthSession(sessionId, user.id, expiresAt);
    return { token: this.#sign(sessionId), user: this.#principal(user) };
  }

  async resolve(request) {
    const raw = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (!raw) return null;
    const [sessionId, signature] = raw.split('.');
    if (!sessionId || !signature || !this.#verify(sessionId, signature)) return null;
    const session = await this.store.findAuthSession(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      if (session) await this.store.deleteAuthSession(sessionId);
      return null;
    }
    await this.store.touchAuthSession?.(sessionId);
    const user = await this.store.findUser(session.userId);
    return user ? this.#principal(user) : null;
  }

  async clear(request) {
    const raw = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (raw) await this.store.deleteAuthSession(raw.split('.')[0]);
  }

  cookie(token) {
    return COOKIE_NAME + '=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800';
  }

  expiredCookie() {
    return COOKIE_NAME + '=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0';
  }

  #sign(value) {
    return value + '.' + createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  #verify(value, signature) {
    const expected = createHmac('sha256', this.secret).update(value).digest('base64url');
    const actual = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  }

  #principal(user) {
    return { userId: user.id, organizationId: user.organizationId, role: user.role ?? 'user', email: user.email };
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  if (!encoded) return false;
  if (!encoded.startsWith('scrypt$')) return password === encoded;
  const [, saltText, digestText] = encoded.split('$');
  if (!saltText || !digestText) return false;
  const expected = Buffer.from(digestText, 'base64url');
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
