# F2：本人凭据保险库与私有模型网关

状态：代码开发与一次性隔离验收；未迁移业务库、未部署常驻服务。F2 不开放用户 Agent 创建、启动或执行，不表示 F3 多租户沙箱、F4 生命周期接入或真实付费 Provider 已验收。

## 1. 本批交付

平台 API 接收用户本人的模型 Key，用 RSA-OAEP-SHA256 + AES-256-GCM 信封加密后入库；API 只加载公钥。只有独立模型网关持有私钥环，且只在持久化运行授权校验通过后解密。浏览器响应、审计和 Runtime 均不接收原始 Provider Key。

可信机器签发器产生短期随机运行令牌，网关将其替换为 Provider Key 调用模型。令牌绑定本人、凭据版本、Agent、run、运行代次、账号治理版本和模型；数据库仅保存 SHA-256，不保存令牌原值。

本批没有签发器的浏览器入口，也没有把签发器接入旧 probe 编排器或真实用户容器。`issueRuntimeGrant` 是供 F4 使用的内部接口；当前只能通过隔离测试构造已确认的运行记录。

## 2. 权限与数据边界

| 身份 | 获准操作 | 不获准操作 |
| --- | --- | --- |
| 平台 API | 本人凭据元数据列表、创建、轮换、撤销 | 读密文表、解密、签发运行令牌 |
| 可信机器签发器 | 为确认的本人 pi run 签发/撤销 grant | 凭据管理、解密、模型代理 |
| 独立模型网关 | 运行调用准入、取本次获准密文、写一次终态回执 | 列表/修改用户凭据、签发 grant、Docker 调度 |
| 用户 Agent（后续接入） | 以短期令牌调用绑定模型 | 获取原始 Key、选择任意出口、跨 run 使用授权 |

`046_model_access.sql` 新增四张 FORCE RLS 表：

- `model_credentials`：本人、Provider ID、标签、版本、状态和加密信封。
- `model_runtime_grants`：令牌哈希、所有权、运行/凭据/治理版本、模型、期限及调用额度。
- `model_gateway_requests`：调用占位、125 秒租约、终态及可空 input/output Token。
- `model_access_audit`：创建、轮换、撤销、签发、准入及调用终态的标识与时间，不存 Key、哈希、密文、提示词、响应正文或上游错误。

调用者不直读写这些表，包含可绕过 RLS 的 TRUNCATE 权限也会撤销。首次创建函数时清除继承的默认 EXECUTE，迁移重跑保留已经明确授予的函数权限与历史数据；不会替其他既有表重写默认授权。

本人范围由可信后端 Principal 决定。平台管理员调用本人 API 也没有跨用户特权。受限函数不能防止已泄漏的可信 API 数据库凭据伪造 actor；API、签发器与网关必须使用不同的专用数据库登录。

## 3. 默认关闭的本人 API

前缀为 `/api/user/model-credentials`，未启用时返回 404。启用必须同时满足：平台模式、Better Auth、PostgreSQL、显式开关及有效公钥配置。所有响应均为 `no-store`；写入必须使用配置的可信同源 Origin，不能通过 Host 或转发头决定信任。

| 方法与路径 | 正文 | 作用 |
| --- | --- | --- |
| GET 前缀 | 无 | 最多 50 条本人凭据元数据，active 优先 |
| POST 前缀 | `provider`, `label`, `apiKey` | 创建，服务端生成 UUID，每人最多 20 条 active |
| PUT 前缀`/:id` | `apiKey`, `expectedVersion` | 轮换，递增版本，旧 grant 失效 |
| DELETE 前缀`/:id` | `expectedVersion` | 撤销并递增版本，旧 grant 失效 |

暂停账号允许本人元数据查询，不允许写入；封禁账号拒绝访问。跨本人范围的 ID 返回 404。标签、Key、Provider 与模型 ID 均有界，拒绝未知字段；不接受自定义上游地址、请求头或组织/用户字段。

创建不是按请求 UUID 幂等：结果丢失时先重新列表核实，不盲目重发创建。轮换/撤销使用 `expectedVersion` 处理并发与过期页面。撤销保留加密历史，不是物理擦除或备份销毁。

凭据接口正文最多 8 KiB、接收最多 10 秒；每个 API 副本最多 16 个在途操作、每 actor 每分钟 120 次本地请求预算。数据库响应等待上限 5 秒，但超时后操作仍可能提交；并发名额持续占用到实际操作结束，调用者应先查询确认结果。这些进程内保护不是全局用户配额或共享限流，F4 容量准入仍需单独交付。

API 只读取：

```text
BAIRUI_MODEL_CREDENTIALS_ENABLED=1
BAIRUI_MODEL_CREDENTIALS_CONFIG_FILE=/etc/bairui/model-access/public.json
```

`public.json` 示例（占位内容必须替换）：

```json
{
  "keyId": "model-key-2026-01",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "providers": [{ "id": "approved-provider", "models": ["approved-model"] }]
}
```

仅允许一个完整公钥 PEM，不接受私钥、拼接 PEM 或尾随内容。API 不加载网关配置、私钥或 TLS Key。本批没有增加凭据 UI；页面、模板选择和真实部署入口属于后续批次。

## 4. 私有网关与固定出口

独立入口为 `npm run model:gateway`，不加入 `dev`、预发或 Runtime 启动链。不读业务 `.env`；只有显式配置才启动：

```text
BAIRUI_MODEL_GATEWAY_MODE=isolation
BAIRUI_MODEL_GATEWAY_CONFIG_FILE=/etc/bairui/model-access/gateway.json
```

部署时 mode 可以为 `managed`，但这个值不代替网络、证书、数据库迁移或最小授权。示例配置：

```json
{
  "databaseUrl": "postgresql://bairui_model_gateway:REPLACE@DB_HOST/bairui",
  "privateKeyFiles": { "model-key-2026-01": "/etc/bairui/model-access/private.pem" },
  "providers": [{ "id": "approved-provider", "baseUrl": "https://PROVIDER_HOST/v1", "models": ["approved-model"] }],
  "tlsKeyFile": "/etc/bairui/model-access/gateway-tls.key",
  "tlsCertFile": "/etc/bairui/model-access/gateway-tls.crt",
  "host": "127.0.0.1",
  "port": 9496
}
```

示例 Host/密码不是可运行配置。TLS 证书必须匹配 Agent 实际连接的内部 DNS 名称并被其信任；不要关闭证书校验。容器内需要绑定 `0.0.0.0` 时，仍只接入受控内部网络，不发布公网端口、不新增管理端反向代理入口。

网关启动检查专用数据库登录，拒绝超级用户、BYPASSRLS、创建角色/库、角色切换、schema CREATE、F2 直表或凭据/签发函数权限。配置和私钥文件必须为有界普通文件，拒绝最终符号链接；Linux 私有文件只允许当前用户/root 持有且不得向组或其他用户开放。建议 root 管理目录并按运行身份设置只读权限。

仅提供 `GET /livez` 与 `POST /v1/chat/completions`。`livez` 表示进程存活，不代表 Provider、真实 Agent 或所有依赖健康。运行令牌使用唯一 Bearer 头，不用浏览器 Cookie；有 Origin 的浏览器调用被拒绝。

出口由部署 catalog 固定：HTTPS、443、固定 `/.../v1` 路径，没有 userinfo/query/hash。DNS 每次检查全部地址，只在全部合规时选定一个地址用于本次连接；TLS 仍校验原域名/SNI。不使用环境代理、不跟随重定向、不自动重试；拒绝私网、环回、链路本地、元数据、特殊保留空间、IPv4 映射和 IPv6 过渡地址。为保守处理，部分特殊空间内的公网例外也拒绝。网络层仍需在 F3 配置独立出口策略，应用地址检查不代替宿主防火墙。

地址与传输实现核对参考：[Node.js 24 HTTPS](https://nodejs.org/docs/latest-v24.x/api/https.html)、[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/)、[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/)、[Azure 特殊主机地址](https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16)。

## 5. 调用与失败语义

- grant 最长 300 秒、最多 32 次调用，只向可信签发调用者返回一次令牌原值。不是最终用户的长期登录凭据。
- 每次准入重新检查 active 账号、凭据版本/状态、Agent 所有权、当前 control/run/generation/governance 与绑定模型。停止、暂停/封禁、轮换、撤销或代次改变会拒绝下一次准入。
- 数据库中同一 run 跨 grant、进程和网关副本最多有一条未过期的 active 调用占位。数据库先消耗调用额度再访问 Provider。失败不退款、不重放；超过 125 秒的旧占位转为 unknown，允许后续新的显式调用，但不据此重发旧请求。网关中断/超时不证明 Provider 已停止处理；故障暂停或网络不确定时，不能承诺上游处理绝对不重叠或不会产生费用。
- 已准入请求不承诺撤销后瞬时全局中断；只承诺有界截止。机器撤销 grant 在账号封禁后仍允许，已准入调用的终态也能在停止/治理后记录。
- 默认并发 16、入站 JSON 64 KiB、单 SSE 事件 256 KiB、入站/出站流各最多 4 MiB、总截止 120 秒，涵盖请求正文、DNS、上游流和下游背压。独立入口还限制头部、连接和正文接收时间。
- 首批仅支持流式 Chat Completions、文本消息和 function tools，不提供任意 Provider API。`max_tokens` 与 `max_completion_tokens` 二选一，正整数输入最多 65536，出口截到 4096；兼容 pi 1.1.0 的较大模型目录上限。强制 `stream_options.include_usage=true`。
- 普通内容/工具参数只投影协议字段；上游原始错误不透传。已知 Provider Key 和本次 Bearer 的完整字面值可跨网络字节分片脱敏，但不承诺识别语义拆分到多条 delta、编码变形或其他未知秘密。
- 成功结束帧（`finish_reason`、usage、`[DONE]`）要等数据库终态成功保存后才发。保存失败、断开、超时或结果不确定不返回假成功；网关对失败保守记录 unknown，历史调用额度仍保留。
- Token 只取最终 Provider 报告中的合法安全整数。缺失、重复、冲突、无效或仅中间分片报告时为 null；0 只有 Provider 明确报告 0 才成立。费用不按字符/目录价格估算，不执行充值/扣款。这里的 completed 是模型协议完成，不代替完整 Agent 任务成功。

## 6. 后续环境接入（本批未执行）

先备份目标数据库并验证 dump 可读，核对 032、036/037、039 等前置迁移，再追加 046；不倒序重跑旧治理迁移。备份应包含密文与调用历史，私钥环另外加密备份并严格控制访问。只有数据库备份、没有对应私钥无法解密旧凭据。

下列最小授权由 DBA 在实际 schema 中执行，角色名是示例。三个登录角色必须分别创建，不能复用业务 API、Controller 或 DBA 密码；密码通过安全交互/Secret 设施设置，不放入仓库、命令历史或日志。不要给应用角色表级 ALL 或 BYPASSRLS。

```sql
-- 示例 schema 为 public；已有专用 schema 的环境逐项替换。
GRANT USAGE ON SCHEMA public TO bairui_app, bairui_model_issuer, bairui_model_gateway;
GRANT EXECUTE ON FUNCTION
  public.model_credential_list(text,text), public.model_credential_get(text,text,uuid),
  public.model_credential_create(text,text,jsonb), public.model_credential_rotate(text,text,uuid,integer,jsonb),
  public.model_credential_revoke(text,text,uuid,integer) TO bairui_app;
GRANT EXECUTE ON FUNCTION public.model_grant_issue(text,text,jsonb),
  public.model_grant_revoke(uuid) TO bairui_model_issuer;
GRANT EXECUTE ON FUNCTION public.model_request_reserve(text,uuid,text),
  public.model_request_finish(uuid,text,bigint,bigint) TO bairui_model_gateway;
```

为网关指定正确 search_path（且无 CREATE 权限），使静态函数名解析到本安装 schema。没有额外 helper EXECUTE 或直表权限。API 的其他既有业务授权保持原样。迁移/授权失败应停止接入，不回退 Memory、legacy 或旧共享 Key。

密钥生成示例（Linux 管理环境；不是自动部署脚本）：

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

包装主密钥轮换：先向网关添加新私钥并保留旧 keyId，再切换 API 的公钥/keyId。用户正常轮换凭据时用新信封并递增版本；本批没有自动批量重加密。旧密文和备份仍依赖旧私钥，不确认其全部退出前不要删除旧 keyId。撤销与私钥丢失均不允许恢复旧运行令牌。

## 7. 验证与未交付项

```sh
conda run -n cloud --no-capture-output npm run test:model-access
conda run -n cloud --no-capture-output npm run test:model-access:db
conda run -n cloud --no-capture-output npm run test:pi
conda run -n cloud --no-capture-output npm run pi:source:check
```

普通专项的真实 PostgreSQL 用例在未提供专用测试 URL 时跳过。`test:model-access:db` 则创建随机归属、仅回环端口的一次性 PostgreSQL，使用独立受限登录执行实际迁移/并发/权限/HTTPS 链路并精确清理；不读取业务 `.env`，不使用业务数据库，不操作既有容器。缺缓存的固定 PostgreSQL 镜像时拒绝，不静默拉取或替换。

本轮已验证真实 RSA/GCM/AAD 与配置边界、受限 PG 并发和租约、HTTPS 证书/地址钉住/重定向拒绝、中文分片/工具协议/用量、旧令牌失效与独立入口。完整计数以最终验收记录为准。测试身份和 Provider 均为 fixture，不是云端真实账号或付费 Provider。

2026-10-18 本轮最终命令结果（不相加，部分用例重叠）：

| 检查 | 结果 |
| --- | --- |
| `test:model-access` | 58 通过、0 失败、2 真库专项跳过 |
| `test:model-access:db` | 5 通过、0 跳过；其中 2 项真库集成、3 项 adapter 单测，上述两项跳过已在这里实际执行 |
| 后端全量 `npm test --prefix apps/platform-api -- --test-concurrency=2` | 479 通过、0 失败、16 专项跳过；不代表其他历史数据库专项本轮重跑 |
| 管理端 / 客户端单测 | 36 / 37 通过 |
| 管理端 / 客户端生产构建 | 均通过 |
| `test:pi` / `pi:source:check` | 53 通过 / 固定源码与锁文件检查通过 |
| `pi:build` | 两次失败：Docker Hub frontend token 连接超时；没有当前镜像或真实 pi→F2 联调成功记录 |

接口复核中的已确认连接泄漏已修复：17 个不完整超大正文收到固定 413 后，服务端连接数在关闭宽限期内归零；对拒绝结束半连接的对端也有 1 秒销毁兜底。超时正文不执行凭据写入。

网关进程测试运行于 Windows；Linux 私有文件 mode/uid 校验负例保留在测试中，本轮未实跑该 POSIX 分支。Docker 内 PostgreSQL 的实际验证不等于 Linux 网关进程、开机恢复或目标服务器部署验证。

当前 pi 1.1.0 源码/锁文件检查及 53 项 F1 测试通过；本机只有旧 0.85.1 镜像，重建当前镜像在 Docker Hub frontend 匿名 token 网络连接处失败。因此本轮没有完成“当前真实 pi 容器 → F2 网关”实链路，不能拿旧镜像或模拟工具消息代替这项验收。

后续顺序：恢复镜像构建网络并补当前 pi 实链路；F3 完成工具/控制 Secret、文件卷、网络与进程树隔离；F4 接可信签发器、容量准入和真实容器生命周期；F5 再开放模板/Key 页面与用户部署。现有 M1/Grafana 不会因为 F2 自动获得所有容器资源、每用户任务量、Token/费用面板；观测汇总与真实账单另行接入。
