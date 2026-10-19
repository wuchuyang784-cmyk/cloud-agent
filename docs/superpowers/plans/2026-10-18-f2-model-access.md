# F2 Model Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. User has approved F2 and explicitly requested execution; do not pause for another execution-mode choice.

**Goal:** 本人加密凭据与确定运行范围模型代理，保持用户Agent执行关闭。

**Architecture:** src/model-access独立模块；公钥写入API，私钥仅独立网关；046受限函数与Memory/PG同契约；HTTPS固定出口+有界SSE；隔离验收而非部署。

**Tech Stack:** Node24 core crypto/HTTPS、PostgreSQL17/pg、现有BetterAuth/Principal；无新运行依赖。自动化Conda cloud，沿用当前分支，保留既有dirty监控修复，不自动commit/push。

**执行进度（2026-10-18）：** Task1/2/3/4 已实现并通过规格→质量复核；拒绝正文连接泄漏已修复并经真实半连接复验。Task5 真 PG+HTTPS fixture、双端测试/构建及最终集成/文档审查已通过；当前 pi 镜像重建受 Docker Hub 网络错误阻碍，真实 pi 容器→F2 联调和 Linux 网关 POSIX 文件权限分支仍待补验。详细计数与状态以 `.planning/2026-10-18-f2-model-access/` 为准。

## Task 1 — Crypto/config/validation

Files: create apps/platform-api/src/model-access/{crypto,config,validation,errors}.mjs and test/model-access-crypto.test.mjs / model-access-config.test.mjs.

- [ ] RED imports以空对象fallback后断言公开函数存在；真实临时RSA测试secret可回解且密文不含secret，换AAD每一字段或篡改密文/标签/包装密钥均拒绝。命令`conda run -n cloud --no-capture-output node --test apps/platform-api/test/model-access-crypto.test.mjs apps/platform-api/test/model-access-config.test.mjs`。
- [ ] 实现`sealCredential({publicKey,keyId,context,secret})` / `openCredential({privateKeys,context,envelope})`，context精确org/user/id/provider/version，envelope精确version=1,keyId,wrappedKey,iv,ciphertext,tag（base64url canonical），RSA>=3072 OAEP256、AES256GCM12字节IV/16tag。Key字符串16..4096可打印ASCII且无空白/控制/引号/反斜杠，不接受PEM私钥当API公钥。错误固定ModelAccessError，无rawcause。
- [ ] 配置工厂与文件读取：public API `{keyId,publicKeyPem,providers:[{id,models}]}`；gateway `{databaseUrl,privateKeyFiles:{kid:path},providers:[{id,baseUrl,models}],tlsKeyFile,tlsCertFile,host,port}`，providerid固定正则、model有界唯一，HTTPS443无userinfo/query/hash，拒绝IP literal/localhost及未知字段。显式env启用和配置文件才读，不读.env；私钥文件有界普通文件no symlink，坏配置失败不回退。给后续store/gateway导出validators。
- [ ] GREEN与规格→质量复核；不改任何既有代码。

## Task 2 — Persistent credentials/grants/requests

Files: create packages/db/migrations/046_model_access.sql、src/model-access/{memory-store,postgres-store,service}.mjs、test/model-access-store.test.mjs / model-access-postgres.test.mjs，scripts/test-model-access.mjs。

- [ ] RED Memory合约：本人metadata，跨用户404；rotate/revoke version；grant绑定当前owner/run/generation/governance且只存tokenhash；并发同run只能一调用、额度先消耗；终态重复回执不可覆盖，未知usage不补0。PG使用一次性库与两受限连接验证同合约。
- [ ] 契约：`createCredential(scope,{id,provider,label,envelope})`，`listCredentials(scope)`，`rotateCredential(scope,id,{expectedVersion,envelope})`，`revokeCredential(scope,id,expectedVersion)`；`issueGrant({scope,credentialId,agentId,runId,runGeneration,model,tokenHash,ttlSeconds,maxRequests})`返回含grantId的元数据；`revokeGrant(grantId)`；`reserveRequest({tokenHash,requestId,model})`返回已授权context/envelope/provider/model/requestId但不含token；`finishRequest(requestId,{state,inputTokens,outputTokens})`。Service在issuer方法生成随机token/hash，仅返回一次可信caller。
- [ ] 046四表FORCE RLS、PUBLIC拒绝、固定search_path的credential_*、model_grant_*、model_request_*函数。API/issuer/gateway权限分列，依赖039与036/037。每人20active/list50，ttl1..300,maxRequests1..32；runtime当前active_run_id/run_generation/desiredrunning与governanceversion必须匹配。准入与失效遵循治理共享锁；并发DB原子，事务readcommitted，错误不写部分状态。
- [ ] `scripts/test-model-access.mjs`仅自有随机label临时PG，不读业务.env，不pull或操作已有容器。测试环境变量BAIRUI_MODEL_ACCESS_TEST_DATABASE_URL；缺失时DB专项skip，独立入口必须实际运行并清理。GREEN后规格→质量复核。

## Task 3 — Private model gateway

Files: create src/model-access/{gateway,transport,stream,gateway-entry}.mjs，test/model-access-gateway.test.mjs / model-access-stream.test.mjs。

- [ ] RED真实HTTP/TLS fixture：唯一Bearer/固定path，model/run/owner/过期拒绝；Provider收到的是自己的Key而不是runtimeToken，收到固定model与usage选项；不转发Cookie；重定向/私网DNS/超限/断开/错误失败且无重试；usage缺失为null，跨chunk字面Key与Bearer脱敏，终态持久失败不输出DONE。
- [ ] `createModelGateway({store,privateKeys,providers,transport,limits})`工厂；生产transport解析provider固定HTTPS目标并校验DNS所有地址，固定IP握手且验证原hostname TLS，无代理或redirect；测试注入只在工厂。stream解析有界SSE，合法normal文本/工具字段可透传但无原始upstreamerrors，只有合法末次usage入库。并发16/body64KiB/event256KiB/output4MiB/120s，backpressure可取消，request先reserve/消费再网络；中断unknown不退款重放。
- [ ] 入口只读显式配置，TLSserver，受限PGpool，独立npm script，不加入dev/preprod；SIGTERM停止准入、取消等待、关闭pool。GREEN后规格→质量复核。

## Task 4 — Existing platform credential surface

Files: create src/model-access/user-routes.mjs / test/model-access-api.test.mjs，modify app.mjs与labels.mjs（仅有界新增route），package.json独立命令。

- [ ] RED真实appserver测试默认404、缺会话401、开启后本人创建/列表/轮换/撤销、no-store、同源/JSON/输入有界、管理员不可跨owner、suspended读但不写、banned拒绝、失败无Key/密文/rawerror。
- [ ] API config加载公钥且不接私钥，factory options modelCredentials仅NODE_ENVtest可注入Memory。主Store不加通用解密方法，PG模型Store用既有pool的最小函数权限。只实现凭据surface，不加浏览器grant签发/原始代理/Agent创建。所有existing平台capabilities原样。
- [ ] GREEN后规格→质量复核。

## Task 5 — Acceptance/docs/verification

Files: create docs/57-f2-model-access.md、隔离联调tests，modify docs/README.md与AGENTS.md仅新增F2状态；更新本计划与.planning日志，不改现有M1dirty文件。

- [ ] 运行unit、真实受限PG与HTTPS/SSE联调；核对F1兼容协议，多轮tool/usage，评估可用F1镜像的独立实链路，不用真实Key；原容器按ID保留，随机资源精确清理。
- [ ] 后端/平台guard/admin/client及构建回归；专项skip如实列出，静态缺表/权限不会启用fallback。独立规格后质量全量审查，修复重要问题。
- [ ] 文档列出数据/信任边界、密钥生成/轮换/旧key保留、最小GRANT、备份/迁移部署后续、私钥丢失不可解密、在途撤销语义、usage非账单、代码与部署区别、真实Provider与F3/F4/F5未交付项。交付前gitdiff只包含本任务范围，不push/commit/部署。
