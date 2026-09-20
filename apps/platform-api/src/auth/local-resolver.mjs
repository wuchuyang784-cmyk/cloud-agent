// 本地账号身份实现（docs/30-client-backend-architecture.md §4.1）。
//
// 提供真实的注册与登录闭环：口令用 scrypt 哈希落库，会话令牌 HMAC 签名后写入
// HttpOnly cookie。这是生产环境的默认实现；接入 Better Auth 等正式身份提供方时，
// 新增实现并在 resolver.mjs 工厂注册，路由与业务代码不变。
//
// 多组织预留：注册即为用户创建独立的个人组织（kind='personal'）并写入
// organization_members（role='org_admin'）。未来把个人空间升级为团队时，只需向
// 该组织追加成员，无需改写任何业务数据的 organization_id。

import { hashPassword, PasswordSessionResolver } from './password-session.mjs';

export class LocalPrincipalResolver extends PasswordSessionResolver {
  // 注册成功后直接签发会话并返回 { token, user }；邮箱已被占用时返回 null。
  async register(input) {
    const email = String(input.email ?? '').trim().toLowerCase();
    const user = await this.store.createUserWithOrganization({
      email,
      passwordHash: await hashPassword(input.password),
      displayName: input.displayName ?? null,
      // 个人组织名默认取邮箱前缀，未来升级为团队时可在设置中改名。
      organizationName: input.organizationName ?? `${email.split('@')[0] || '用户'} 的个人空间`,
    });
    if (!user) return null;
    return this.issueSession(user);
  }
}
