# F3-A Pi Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. User confirmed detailed F3 design on 2026-10-20. Work in the existing development branch; no automatic commits, pushes or deployment.

**Goal:** 实现独立可验证的 F3-A 协议底座，保护可信控制资产并为 F3-B 原生 Linux 沙箱驱动提供严格契约；不开放用户执行。

**Architecture:** 新建 `runtime/pi/sandbox/`，不改变 F1 production 默认进程模型或 E2 probe。严格 profile 生成双容器策略，可信任务账本与用户文件分离；独立 RPC 通道和固定模型代理均可用真实本机流/HTTP/HTTPS fixture 验证。原生 runsc/限额存储与实际运行单元创建回收属于 F3-B；不是本机模拟验收。

**Tech Stack:** Node.js 24 内置模块、node:test、既有 F1/F2 helper；不安装新依赖，全部命令经 Conda cloud。

## 执行状态

- [x] Task1：实现、专项19项与两轮独立复核（含最终跨模块URL修复）。
- [x] Task2：实现、专项Windows25+3跳过/Linux28项与两轮独立复核（含父目录持久化修复）。
- [x] Task3：实现、专项Windows/Linux各49项与两轮独立复核。
- [x] Task4：实现、专项29项与两轮独立复核。
- [x] Task5：CLI、完整回归、文档与最终复核。

下文 RED/GREEN 条目保留原始实施步骤；完成状态以本节及各任务结果为准。

## 公共约定

- 所有源码在 `apps/platform-api/src/runtime/pi/sandbox/`，所有测试以前缀 `pi-sandbox-` 命名。错误对外固定分类，不返回正文、Secret 或路径。
- profile 由可信机器调用者提供，不是用户部署 DTO。只接收显式白名单字段，配置在校验后深拷贝/冻结；identity 不可被后续输入覆盖。
- 本轮机器模块无 Docker/SSH/DB 副作用；不读取业务 `.env`，不接平台 app/dev/preprod。
- 测试每任务先写并观察 RED，再实现 GREEN。规格和质量复核通过后推进下一任务；保存真实结果，不将 fixture 当作沙箱实跑。

## Task 1：严格 Profile 与双容器策略

状态：完成；19项通过，独立规格/质量复核PASS。最终跨模块URL契约修复另行RED→GREEN并独立复核PASS。

Files: create `profile.mjs`, `policy.mjs`, `apps/platform-api/test/pi-sandbox-policy.test.mjs`。

- [x] RED：测试 `validateSandboxProfile` 拒绝未知字段、错误运行身份、路径穿越、可变镜像、非 runsc、任意网络/命令/env、过大或非法资源；运行专项观察失败。初始0/13；补强15/17。
- [x] GREEN：机器 profile 固定 `schemaVersion:1`，包含 `installationId`、`identity:{organizationId,ownerUserId,agentId,runId,runGeneration,sessionId}`、`sandboxImage/controlImage`（完整 sha256）、`runtime:'runsc'`、`storageRoot`（规范 POSIX 绝对非根目录）、`gatewayUrl`（固定配置 HTTPS、无用户名/密码/query/hash）、`model`、`resources:{cpuMillis,memoryBytes,pidsLimit,tmpfsBytes,workspaceBytes,workspaceInodes}`。资源均正安全整数且有明确上限。所有其他字段拒绝。
- [x] GREEN：`compileSandboxPolicy(profile)` 生成纯数据描述，不执行 Docker、不生成可启动命令；返回按 installation/agent/run hash 派生的资源名/路径及分离挂载。sandbox=runsc/network none、非root、只读根、capDrop ALL/noNewPrivileges、无端口/设备/Secret、专用 channel 只读；control 无用户工作区/会话，channel 可写、独立可信状态、secret 只读，独立有界资源。user workspace/session 配额描述不可缺。
- [x] 验证示例：

```js
const profile = validateSandboxProfile(machineConfiguration);
const policy = compileSandboxPolicy(profile);
assert.equal(policy.sandbox.networkMode, 'none');
assert.equal(policy.sandbox.runtime, 'runsc');
assert.equal(policy.control.mounts.some(m => m.target === '/workspace'), false);
assert.equal(policy.sandbox.mounts.some(m => m.target === '/run/secrets'), false);
```

- [x] Run `conda run -n cloud --no-capture-output node --test apps/platform-api/test/pi-sandbox-policy.test.mjs`，最终19通过，独立规格和质量复核均PASS。

## Task 2：可信状态与永久终止记录

状态：完成；Windows 25通过/3 Linux或POSIX明确跳过，Linux组件28通过/0跳过。首开并发竞态与父目录同步均实测RED后修复；最终父目录同步独立规格/质量复验PASS。

Files: create `state.mjs`, `apps/platform-api/test/pi-sandbox-state.test.mjs`。

- [x] RED：真实临时目录测试任务 UUID 独占占位、重启拒绝重放、错误 owner/run/session、终态持久失败、symlink、未知/损坏记录、run 停止后拒绝任务和旧代次复活。
- [x] GREEN：`openSandboxState({directory,identity})` 只读/写显式受保护可信目录；绑定组织/用户/Agent，跨 run 保留任务去重；逐 run 记录 exact run/generation/session 与永久 stopping/stopped 标志。`reserve(task)` 在返回前持久化 unknown；`finish(taskId,status)` 仅对已有本人任务做单向终态；`beginStop()` 先持久停止意图；`confirmStopped()` 仅在调用方提供本 run 精确确认时终止。未知不写假 stopped。所有写入 exclusive/atomic rename，Linux 文件与目录 fsync，拒绝 symlink/路径漂移/宽松权限，Windows测试不声称POSIX验证。
- [x] GREEN：同目录进程/副本不并发写，通过 exclusive lock 文件拒绝第二个打开者，锁由明确 close 释放；崩溃遗留锁不自动删除，防止两个 writer。保留历史，不新增业务迁移。
- [x] 示例：

```js
const state = await openSandboxState({directory, identity});
await state.reserve({taskId, sessionId: identity.sessionId});
await assert.rejects(state.reserve({taskId, sessionId: identity.sessionId}));
await state.beginStop();
await assert.rejects(state.reserve({taskId: anotherId, sessionId: identity.sessionId}));
await state.close();
```

- [x] Run `conda run -n cloud --no-capture-output node --test apps/platform-api/test/pi-sandbox-state.test.mjs`，规格/质量复核。

## Task 3：有界 RPC 流通道

状态：完成；Windows/Linux组件各49通过，独立规格/质量复核PASS。跨平台背压夹具已显式固定外层highWaterMark，不改变生产限额。

Files: create `rpc-channel.mjs`, `apps/platform-api/test/pi-sandbox-rpc.test.mjs`。

- [x] RED：真实 duplex/socket 流验证 request/response ID 与 command 对应、固定方法、单任务 prompt、错误帧/方向/UTF8/超长行/原始总量、断开/timeout、慢消费者、关闭后迟到帧拒绝。
- [x] GREEN：`SandboxRpcChannel` 接收已有 duplex stream，不 spawn pi、不持 Secret、不访问 Docker。只允许 `get_state,set_auto_retry,set_auto_compaction,prompt,abort`；关闭重试/压缩只接受 false；prompt 文本有界、ID 内部随机生成、pending 有界。每帧类型和关联检查后才发送 event；stream 背压、总量、deadline 和断开时所有 pending 都失败且 dead 状态永久。
- [x] 示例：

```js
const rpc = new SandboxRpcChannel(stream, {rpcTimeoutMs: 1000});
const pending = rpc.request('get_state');
peer.write(JSON.stringify({type:'response', id, command:'get_state', success:true, data:{}})+'\n');
await pending;
await assert.rejects(rpc.request('set_model', {model:'other'}));
await rpc.close();
```

- [x] Run `conda run -n cloud --no-capture-output node --test apps/platform-api/test/pi-sandbox-rpc.test.mjs`，规格/质量复核。

## Task 4：固定模型中转

状态：完成；29项通过，独立规格复验及独立质量复核PASS。

Files: create `model-proxy.mjs`, `apps/platform-api/test/pi-sandbox-model-proxy.test.mjs`。

- [x] RED：实际 HTTP→HTTPS fixture 验证只允许 POST /v1/chat/completions、模型绑定、无 Origin/Cookie/动态上游、sandbox Authorization 不透传、固定上游 TLS/CA、一次请求不重试、并发/正文/输出/时限、下游断开、无错误正文泄漏、关闭释放连接。
- [x] GREEN：`createSandboxModelProxy({gatewayUrl,model,token,ca,...boundedLimits})` 提供 handler/server factory；测试显式绑定 loopback，Linux部署只能监听本 run 专用 UDS。固定 HTTPS origin/path，不跟随重定向/环境代理；生成自己的 Bearer；始终以 F2 验证的绑定模型/受限请求协议调用。成功只投影 SSE content-type 与数据，有限总字节与时限/背压；异常固定分类，不记录授权或正文。known token 跨片段完整字面值脱敏。不得新增付费Provider调用或Token估算。
- [x] 示例：

```js
const proxy = createSandboxModelProxy({gatewayUrl, model:'bound-model', token, ca});
const response = await fetch(url + '/v1/chat/completions', {
  method:'POST', body: JSON.stringify({model:'other',stream:true,messages:[]})
});
assert.equal(response.status, 403);
await proxy.close();
```

- [x] Run `conda run -n cloud --no-capture-output node --test apps/platform-api/test/pi-sandbox-model-proxy.test.mjs`，规格/质量复核。

## Task 5：显式检查入口、回归和交付文档

状态：完成；CLI独立规格/质量复核PASS，Windows12+1跳过/Linux组件13通过；根专项134+4跳过、后端601+19跳过、F1/F2/平台guard回归通过。整批最终独立复验PASS，两处P2已修复关闭。未提交/推送/部署。

Files: create `scripts/pi-sandbox-check.mjs`, `scripts/pi-sandbox-check.test.mjs`, `docs/58-f3-pi-sandbox.md`; modify `package.json`（仅新增专项/检查 script）、`docs/README.md`、`AGENTS.md`（只追加准确 F3-A 状态）。

- [x] RED：检查入口只接受 `--config <file>`，不读业务env；读取有界无symlink普通文件、输出无Secret profile/policy摘要，拒绝 --up/任意执行，导入无副作用。
- [x] GREEN：`npm run pi:sandbox:check -- --config <file>` 只验证/打印策略不部署；`npm run test:pi:sandbox` 汇总本批测试。不得增加伪造运行成功的入口。实际工作负载 connector/relay 入口、runsc驱动、可信运行单元创建/回收与实机报告仍是F3-B，文档准确列出，不因纯策略/fixture通过宣布F3完整。
- [x] 跑专项、F1 53、F2 专项、平台guard与后端回归；`git diff --check`；检查只修改本批文件/根npm/docs导航与项目状态，不改已有M1脏文件。
- [x] 记录 `pi:build` 网络失败、runsc缺失与原生沙箱挂载/持久存储/UID隔离未实跑；不尝试修改全局DNS/安装runsc/重启Docker或迁移云端。Linux组件文件权限分支另跑，不代替原生挂载验收。

## 完成口径

本批可称“F3-A 控制协议底座已实现并通过本机验证”，不得称“真实多租户沙箱已验收/用户 Agent 已开放”。用户已确认后持续执行上述任务，不在任务间重复申请开始许可；native/付费/云端工作保持显式后续范围。
