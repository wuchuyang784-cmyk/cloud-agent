# 统一管理与监控控制台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有管理端内提供平台概览、用户账号、Agent 服务、运行监控和告警，并让详细 Grafana 看板复用 Better Auth 平台权限。

**Architecture:** 平台 API 新增固定 Prometheus 查询和网关鉴权端点；9443 网关对每个日常 Grafana 请求复核 active 平台角色，再注入不可伪造的只读 Auth Proxy 身份。Grafana、Prometheus、Alertmanager 和独立 Grafana 管理员应急会话继续运行；前端将监控状态与账号列表状态分离，监控故障不拖垮管理功能。

**Tech Stack:** Node.js 24 原生 HTTP/测试、React 19、TypeScript、Vite、Caddy、Grafana 13、Prometheus 3、Docker Swarm、Better Auth、PostgreSQL。

**Execution note:** 用户已要求连续开发。当前工作位于 `codex/phase2-simulation-scheduler`，不是 main；按已批准设计在当前目录执行。2026-10-08 用户已进一步授权按“提交推送、备份、常驻预发更新、自动与浏览器验收”的顺序继续。

**Implementation status (2026-10-07):** Tasks 1–6 的工作区代码、单元/配置测试、前端构建、固定 Grafana/Caddy 隔离兼容性测试和文档已完成；`test-preprod.mjs` 已加入部署后 Viewer、伪造头、退出失效与应急登录验收。按本轮边界未执行会重启常驻预发的 `test:preprod`，也未提交、推送或部署。

---

### Task 1: 验证单 Grafana 的统一入口与应急入口兼容性

**Files:**
- Create: `scripts/monitoring-grafana-compat.test.mjs`
- Modify: `scripts/monitoring-config.test.mjs`
- Modify: `scripts/monitoring-config.mjs`

- [ ] **Step 1: 写失败配置测试**

断言 Grafana 配置满足以下固定合同：

```js
assert.equal(grafana.environment.GF_SERVER_ROOT_URL, 'https://localhost:9443');
assert.equal(grafana.environment.GF_AUTH_PROXY_ENABLED, 'true');
assert.equal(grafana.environment.GF_AUTH_PROXY_HEADER_NAME, 'X-Bairui-Monitor-User');
assert.equal(grafana.environment.GF_AUTH_PROXY_HEADER_PROPERTY, 'username');
assert.equal(grafana.environment.GF_AUTH_PROXY_AUTO_SIGN_UP, 'true');
assert.equal(grafana.environment.GF_AUTH_PROXY_ENABLE_LOGIN_TOKEN, 'false');
assert.equal(grafana.environment.GF_USERS_AUTO_ASSIGN_ORG_ROLE, 'Viewer');
assert.equal(grafana.environment.GF_SECURITY_ALLOW_EMBEDDING, 'true');
```

Run: `conda run -n cloud --no-capture-output node --test scripts/monitoring-config.test.mjs`

Expected: FAIL because the Auth Proxy contract is absent.

- [ ] **Step 2: 实现最小配置并跑静态测试**

只增加所需 Grafana 环境变量；匿名访问和登录令牌保持关闭，自动角色只能是 Viewer。

Run: `conda run -n cloud --no-capture-output node --test scripts/monitoring-config.test.mjs`

Expected: PASS.

- [ ] **Step 3: 用固定镜像进行隔离兼容性验证**

测试脚本创建临时 Docker 网络、Grafana、Caddy 和假鉴权服务，不挂载现有卷或 Secret。它验证：

```js
// 统一入口：有效平台 Cookie 经网关鉴权后创建 Viewer 技术身份。
assert.equal(protectedDashboard.status, 200);
assert.match(protectedDashboard.text, /bairui-platform/);
assert.equal(await grafanaRole('bairui:test-user'), 'Viewer');

// 应急入口：登录页不依赖平台鉴权；伪造会话仍由 Grafana 拒绝。
assert.equal(emergencyLogin.status, 200);
assert.equal(fakeEmergencySession.status, 401);

// 未信任来源伪造 Auth Proxy 头不能自动登录。
assert.notEqual(untrusted.status, 200);
```

Run: `conda run -n cloud --no-capture-output node scripts/monitoring-grafana-compat.test.mjs`

Expected: PASS and all temporary resources are removed in `finally`. If the fixed image cannot support both paths safely, stop implementation and report the evidence rather than weakening authentication.

### Task 2: 添加只读监控查询接口

**Files:**
- Create: `apps/platform-api/src/admin/monitoring.mjs`
- Create: `apps/platform-api/test/admin-monitoring.test.mjs`
- Modify: `apps/platform-api/src/admin/routes.mjs`
- Modify: `apps/platform-api/src/admin/store.mjs`
- Modify: `apps/platform-api/src/app.mjs`

- [ ] **Step 1: 写权限、固定查询和状态投影红测**

使用真实 `createApp` 与注入的监控 transport，覆盖：无会话 401、普通用户/撤权/suspended 403、三种 active 平台角色可读、未知参数 422、禁用 503、上游超时/超限 503、无内部错误泄露。

固定 DTO：

```js
{
  status: 'fresh' | 'empty' | 'stale',
  sampledAt: string | null,
  metrics: {
    apiReplicas: { status, value, sampledAt },
    databaseReady: { status, value, sampledAt },
    requestRate: { status, value, sampledAt },
    latencyP95: { status, value, sampledAt },
    errorRate: { status, value, sampledAt },
    firingAlerts: { status, value, sampledAt }
  }
}
```

告警 DTO 只含 `name`、`severity`、`state`、`activeAt`、`instance`，最多 100 条。

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/admin-monitoring.test.mjs`

Expected: FAIL with missing monitoring route/module.

- [ ] **Step 2: 实现有界查询客户端**

`createAdminMonitoring({ baseUrl, fetchImpl, timeoutMs = 3000, maxBytes = 262144, maxConcurrent = 4, maxQueue = 32 })` 仅暴露 `overview()`、`alerts()`。查询表达式由模块常量持有；用户不能提交 URL 或 PromQL。使用覆盖排队与执行的绝对截止时间、响应流字节上限、有界队列和并发栅栏，验证 Prometheus `status === 'success'` 后再投影固定字段；新鲜度来自固定 `timestamp(...)` 查询返回的底层样本时间。

- [ ] **Step 3: 接入权限与路由**

`readAdmin(..., 'me')` 返回：

```js
permissions: ['users:read', 'agents:read', 'monitoring:read', 'alerts:read', ...(admin ? ['users:govern'] : [])]
```

路由只接受：

```text
GET /api/admin/monitoring/overview
GET /api/admin/monitoring/alerts?severity=info|warning|critical&state=firing|pending
```

所有响应 `Cache-Control: no-store`、`Vary: Cookie`。依赖未配置/异常统一返回 `monitoring_unavailable`，不返回上游内容。

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/admin-monitoring.test.mjs apps/platform-api/test/admin.test.mjs`

Expected: PASS.

### Task 3: 添加逐请求鉴权端点与网关策略

**Files:**
- Create: `apps/platform-api/test/admin-monitoring-access.test.mjs`
- Modify: `apps/platform-api/src/admin/routes.mjs`
- Modify: `scripts/preprod-config.mjs`
- Modify: `scripts/preprod-config.test.mjs`

- [ ] **Step 1: 写代理安全红测**

覆盖 `/api/admin/monitoring/access` 的 `bairui:<Principal ID>` 技术身份、无会话 401、suspended/无角色 403、三种平台角色成功、非 GET/HEAD 拒绝，并验证退出/撤权后的下一请求被拒绝。

```js
assert.equal(response.headers.get('x-bairui-monitor-user'), 'bairui:user-a');
assert.equal(response.status, 204);
assert.equal(forbiddenWrite.status, 405);
```

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/admin-monitoring-access.test.mjs`

Expected: FAIL because the proxy does not exist.

- [ ] **Step 2: 实现鉴权端点与严格网关路由**

API 端点只返回 204、`X-Bairui-Monitor-User` 与固定 `X-Bairui-Monitor-Role: Viewer`，不创建 Grafana token。9443 网关先删除客户端同名身份头，`forward_auth` 成功后复制服务端身份头；Grafana 以 `sync_ttl=0` 每请求同步角色。日常反代删除 Cookie/Authorization 并剥离 Set-Cookie。`/login`、白名单 `/public/*` 登录资源和携带 `grafana_session` 的请求走应急链路、清除代理身份头并由 Grafana校验；伪造 Cookie 不由 Caddy 视为认证成功。

- [ ] **Step 3: 接入现有管理授权**

鉴权端点复用 `handleAdmin` 的 `readAdmin(..., 'me')` 结果并要求 `monitoring:read`。`banned` 继续在全局身份层返回 401，suspended/无角色返回 403。Grafana Auth Proxy whitelist 只接受网关监控网络的精确 IP；CSP 仅允许 `https://localhost:8443` 嵌入。

Run: `conda run -n cloud --no-capture-output node --test apps/platform-api/test/admin-monitoring-access.test.mjs apps/platform-api/test/admin-monitoring.test.mjs apps/platform-api/test/admin.test.mjs`

Expected: PASS.

### Task 4: 实现五项管理导航和故障隔离

**Files:**
- Modify: `apps/admin-console/src/session.ts`
- Modify: `apps/admin-console/src/App.tsx`
- Modify: `apps/admin-console/src/styles.css`
- Create: `apps/admin-console/src/OverviewView.tsx`
- Create: `apps/admin-console/src/MonitoringView.tsx`
- Create: `apps/admin-console/src/AlertsView.tsx`
- Modify: `apps/admin-console/test/session.test.mjs`
- Create: `apps/admin-console/test/navigation.test.mjs`

- [ ] **Step 1: 写前端模型红测**

将 `View` 扩展为 `overview | users | agents | monitoring | alerts`，默认 overview。测试监控数据独立 loading/error、30 秒刷新、hidden 停止、focus 重查身份、切页/退出取消旧请求并阻止乱序回填；监控 503 不能清空 `me` 或使用户/Agent 页面不可访问。

Run: `conda run -n cloud --no-capture-output npm test --prefix apps/admin-console`

Expected: FAIL with missing views/model behavior.

- [ ] **Step 2: 实现模型与三个聚焦组件**

`AdminSession` 将基础身份和列表状态与 monitoring 状态分开；只在身份 401/403 时清空所有受保护数据。概览/告警校验固定 DTO，不保存 Cookie 或令牌。`MonitoringView` 的 iframe 只在页面激活且拥有 `monitoring:read` 时存在，src 固定为 `https://localhost:9443/d/bairui-platform/bairui-platform?kiosk`。

- [ ] **Step 3: 接入五项导航与响应式样式**

使用 `LayoutDashboard`、`Users`、`Bot`、`ChartNoAxesCombined`、`BellRing` 图标。桌面维持 206px 侧栏；窄屏导航可横向滚动或两行显示，不截断退出、角色和告警状态。运行监控页明确“只读”；告警页明确“当前告警，不是通知历史”。

Run: `conda run -n cloud --no-capture-output npm test --prefix apps/admin-console`

Expected: PASS.

Run: `conda run -n cloud --no-capture-output npm run build --prefix apps/admin-console`

Expected: TypeScript 与 Vite 构建成功。

### Task 5: 接入预发/开发配置并修复镜像版本输入

**Files:**
- Modify: `scripts/preprod-config.mjs`
- Modify: `scripts/monitoring-config.mjs`
- Modify: `scripts/preprod.mjs`
- Modify: `scripts/preprod-config.test.mjs`
- Modify: `scripts/monitoring-config.test.mjs`
- Modify: `scripts/test-preprod.mjs`
- Modify: `apps/admin-console/vite.config.ts`
- Modify: `.env.example`

- [ ] **Step 1: 写配置红测**

断言 API 仅在监控启用时获得固定内网 Grafana/Prometheus 地址；Grafana Auth Proxy whitelist 只包含 API 服务网络的确定来源范围或地址；9443 清除身份代理头且保留独立登录；8443 的 Grafana 子路径先进入 API。断言修改任意管理端构建输入会改变 `revision()`。

Run: `conda run -n cloud --no-capture-output npm run test:preprod:config`

Expected: FAIL with missing monitoring environment and admin revision inputs.

- [ ] **Step 2: 实现配置**

预发 stack 在监控启用时设置 `BAIRUI_PROMETHEUS_URL=http://bairui-monitor_prometheus:9090`，API 加入监控内部网络；未启用时不设置地址。9443 继续只绑定回环，日常请求以 `forward_auth` 复核 Better Auth；应急登录与 Grafana 会话直连但不接受代理身份。开发环境未启用监控时显示未配置，不内置凭据。

`revision()` 加入：

```js
await add('apps/admin-console/src');
for (const file of ['package.json','package-lock.json','index.html','tsconfig.json','vite.config.ts']) {
  hash.update('apps/admin-console/' + file).update(await readFile(join(root, 'apps/admin-console', file)));
}
```

- [ ] **Step 3: 扩展预发验收但不执行常驻故障测试**

自动验收代码增加统一登录看板、Viewer 权限、伪造头拒绝、退出后代理 401、应急入口登录可达检查。本开发轮只运行配置/单元/隔离 Docker 验收，不运行会重启常驻预发的 `test:preprod`。

Run: `conda run -n cloud --no-capture-output npm run test:preprod:config`

Expected: PASS.

Run: `conda run -n cloud --no-capture-output npm run test:monitoring:config`

Expected: PASS.

### Task 6: 回归、安全审查与文档

**Files:**
- Modify: `docs/38-phase3-monitoring.md`
- Modify: `docs/39-dual-console-phase-a.md`
- Modify: `docs/README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 执行专项与全量回归**

```powershell
conda run -n cloud --no-capture-output node --test apps/platform-api/test/admin-monitoring.test.mjs apps/platform-api/test/admin-monitoring-access.test.mjs
conda run -n cloud --no-capture-output npm run test:admin
conda run -n cloud --no-capture-output npm run test:admin:web
conda run -n cloud --no-capture-output npm run build:admin
conda run -n cloud --no-capture-output npm run test:platform
conda run -n cloud --no-capture-output npm run test:preprod:config
conda run -n cloud --no-capture-output npm run test:monitoring:config
conda run -n cloud --no-capture-output npm test --prefix apps/platform-api
conda run -n cloud --no-capture-output git diff --check
```

Expected: 0 failures. 独立数据库入口如由套件设计跳过，须通过相应专项实际执行，不能把 skip 写成通过。

- [ ] **Step 2: 完成安全检查**

逐项确认：无硬编码 Secret、无任意 URL/PromQL、无 Cookie/Authorization 转发、身份头不能伪造、每请求授权、只读方法、响应上限/超时/并发限制、错误脱敏、CSP 精确、应急入口不依赖平台身份且不匿名。

- [ ] **Step 3: 更新中文文档与边界**

记录本机实际测试数字、兼容性报告路径、已实现权限和故障语义。明确代码尚未部署常驻预发，不宣称真实 Agent、主机全量指标、告警历史或生产高可用。

- [ ] **Step 4: 最终只读审查**

根据 `requesting-code-review` 清单审查全部 diff，修复阻塞项后复跑对应验证。保持变更未提交，等待用户决定是否部署、提交和推送。
