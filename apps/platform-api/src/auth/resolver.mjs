// 身份解析层（docs/30-client-backend-architecture.md §4.1）。
//
// 所有 /api/user/*、/api/admin/* 路由都必须先经过 PrincipalResolver 解析出
// 不可绕过的 Principal，再做授权。业务代码不得相信前端提交的
// userId / organizationId / role。
//
// Principal 形状（多组织预留）：
//   { userId, email, organizationId, role, organizations: [{ id, name, kind, role }] }
// organizationId 是"当前激活组织"，作为 RLS 的 set_config('app.organization_id')
// 输入，必须来自服务端会话，绝不能来自请求体。
//
// 支持的模式：
//   dev   —— 受限开发替身，仅本地开发/隔离测试，生产环境拒绝启动；
//   local —— 历史本地账号；保留默认值以兼容尚未迁移的环境。
//   better-auth —— 开源认证组件；导入 032 后显式启用。
//
// Better Auth 接入、迁移与生产限制见 docs/33-phase1-better-auth.md。

import { DevPrincipalResolver } from './dev-resolver.mjs';
import { LocalPrincipalResolver } from './local-resolver.mjs';
import { BetterAuthPrincipalResolver } from './better-auth-resolver.mjs';

const SUPPORTED_MODES = new Set(['dev', 'local', 'better-auth']);

export function createPrincipalResolver(store, options = {}) {
  const env = options.env ?? process.env;
  const requestedMode = options.mode ?? env.BAIRUI_AUTH_MODE;
  const isProduction = env.NODE_ENV === 'production';
  // 未显式指定时默认使用本地账号（local）：控制台已提供注册/登录页，
  // 开发环境也需要真实账号闭环。需要受限替身时显式设置 BAIRUI_AUTH_MODE=dev。
  const mode = requestedMode ?? 'local';

  if (!SUPPORTED_MODES.has(mode)) {
    throw new Error(`[auth] 不支持的身份解析模式: ${String(mode)}（当前支持: ${[...SUPPORTED_MODES].join(', ')}）`);
  }

  // docs/30 §4.2：生产环境禁止使用开发身份替身，避免"暂不做登录"演变成"业务接口没有身份边界"。
  // 注意这里只拦截显式选择 dev 的情况；生产默认走 local，不受影响。
  // 隔离测试环境如需放行，显式传入 allowDevInProduction。
  if (mode === 'dev' && isProduction && options.allowDevInProduction !== true) {
    throw new Error('[auth] NODE_ENV=production 时禁止使用开发身份替身；请使用 local 模式，或显式设置 allowDevInProduction 用于隔离测试环境。');
  }

  if (mode === 'better-auth') return new BetterAuthPrincipalResolver(store, { ...options, env });
  return mode === 'local' ? new LocalPrincipalResolver(store, options) : new DevPrincipalResolver(store, options);
}
