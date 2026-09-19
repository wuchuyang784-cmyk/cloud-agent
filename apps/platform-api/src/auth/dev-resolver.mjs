// 开发期身份替身（docs/30-client-backend-architecture.md §4.2）。
//
// 仅在本地开发或隔离测试环境启用；生产环境由 resolver 工厂直接拒绝启动。
// 与本地账号实现共用会话机制，差别只在登录前按需写入固定的种子用户。
// 行为约束：
//   - 只接受服务端配置的固定测试用户（options.devUser / seed users）；
//   - 前端不能自定义 userId / organizationId / role 来取得身份；
//   - 口令用 scrypt 校验，会话 token 用 HMAC 签名后写入 cookie。
//
// 接入正式身份提供方后本文件仍保留，用于本地开发和测试。

import { hashPassword, PasswordSessionResolver } from './password-session.mjs';

export class DevPrincipalResolver extends PasswordSessionResolver {
  constructor(store, options = {}) {
    super(store, options);
    this.devUser = options.devUser;
  }

  async prepareLogin() {
    if (this.devUser && this.store.ensureDevUser) {
      await this.store.ensureDevUser({ ...this.devUser, passwordHash: await hashPassword(this.devUser.password) });
    }
  }
}
