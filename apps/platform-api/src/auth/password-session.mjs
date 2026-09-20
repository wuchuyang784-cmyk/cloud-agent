// 基于密码与会话的身份解析基类（docs/30-client-backend-architecture.md §4.1）。
//
// 开发替身（dev-resolver）与本地账号（local-resolver）共用同一套会话机制：
// scrypt 口令校验、HMAC 签名会话令牌、HttpOnly cookie。
// 接入正式身份提供方时新增实现并在 resolver 工厂注册，业务代码不变。
//
// 契约（任何实现都必须满足）：
//   resolve(request) -> Promise<Principal | null>
//     解析当前请求身份；无有效会话返回 null，路由层据此返回 401。
//   login(email, password) -> Promise<{ token, user } | null>
//     口令校验通过后签发会话。
//   clear(request) -> Promise<void>
//     注销当前会话。
//   cookie(token) / expiredCookie() -> string
//     会话 cookie 的写入与清除，属于 HTTP 层关注点。

import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const COOKIE_NAME = 'bairui_session';

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('='))
    .filter(([key, value]) => key && value)
    .map(([key, ...value]) => [key, value.join('=')]));
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  if (!encoded) return false;
  // 兼容开发 seed 中的明文口令；哈希口令一律走 scrypt 定长比较。
  if (!encoded.startsWith('scrypt$')) return password === encoded;
  const [, saltText, digestText] = encoded.split('$');
  if (!saltText || !digestText) return false;
  const expected = Buffer.from(digestText, 'base64url');
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class PasswordSessionResolver {
  constructor(store, options = {}) {
    this.store = store;
    this.secret = options.secret ?? process.env.BAIRUI_SESSION_SECRET ?? 'local-development-session-secret';
    this.sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  }

  // 子类钩子：登录前的准备动作（例如开发替身按需写入固定种子用户）。
  async prepareLogin() {}

  async login(email, password) {
    await this.prepareLogin();
    const user = await this.store.findUserByEmail(email ?? '');
    if (!user || !(await verifyPassword(password ?? '', user.passwordHash ?? user.password))) return null;
    return this.issueSession(user);
  }

  // 签发会话：写入会话存储并返回签名后的 cookie 值。注册与登录共用同一入口。
  async issueSession(user) {
    const sessionId = randomBytes(24).toString('base64url');
    await this.store.createAuthSession(sessionId, user.id, Date.now() + this.sessionTtlMs);
    return { token: this.#sign(sessionId), user: await this.#principal(user) };
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

  // Principal 形状（多组织预留）：
  //   { userId, email, organizationId, role, organizations: [{ id, name, kind, role }] }
  //
  // organizationId 表示"当前激活组织"，它会作为 RLS 的
  // set_config('app.organization_id') 输入，必须来自服务端会话，绝不能来自请求体。
  // organizations 是用户所属的全部组织，供前端组织选择器与未来的组织切换接口使用。
  // 当前个人租户只属于一个组织，因此 organizationId 恒等于该组织；升级为多组织时，
  // 只需改变"哪个组织是激活组织"的选取规则，路由与业务代码无需改动。
  async #principal(user) {
    const organizations = await this.store.listUserOrganizations?.(user.id) ?? [];
    const active = organizations.find((organization) => organization.id === user.organizationId) ?? organizations[0] ?? null;
    return {
      userId: user.id,
      email: user.email,
      organizationId: active?.id ?? user.organizationId,
      role: active?.role ?? user.role ?? 'user',
      organizations,
    };
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
}
