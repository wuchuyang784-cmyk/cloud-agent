# F2：本人凭据保险库与运行范围模型网关

## 已批准的能力与边界

用户批准F2：复用BetterAuth/Principal/RLS，为本人模型凭据建立加密存储，并使绑定确定Agent/run的短期token通过可信模型网关调用Provider；原始Key不交给pi或返回浏览器。用户Agent创建、执行、旧Worker、探针编排器及默认启动链继续保持原状。本批只开发/隔离验收，不提交推送、部署、迁移业务库、修改云服务器或调用真实付费模型。

## 架构

- 平台API（显式opt-in）只持RSA公钥，接收本人Key后使用随机AES256GCM信封加密，数据密钥用RSA-OAEP-SHA256包装；AAD绑定完整所有权、credentialId/provider/version/keyId。解密仅在独立模型网关私钥环内执行。主密钥不入库、不在用户容器。
- 可信部署catalog固定providerId→HTTPS endpoint+model allowlist；用户输入只选id/model，不能指定URL/请求头/代理。首批单一chat-completions流式协议，不默认绑定某付费服务，不引入第三方SaaS。
- 原子持久grant绑定org/user/credentialVersion/agent/run/runGeneration/governanceVersion/model及<=300秒期限、<=32次模型调用额度。只有受限机器issuer可签发/撤销，无浏览器签发或解密端点。token为32随机字节base64url，数据库只存SHA256，原值只返回可信调用者一次。
- gateway每次准入检查active账号、未撤销凭据版本、grant、Agent归属及当前controls/run代次与运行意图；同run最多一条在途调用，额度在网络副作用前消耗。失败不自动退款额度或重试。停止/治理/撤销拒绝下一次准入；已准入流只承诺有界截止，不承诺瞬时全局强杀。
- gateway只接固定POST /v1/chat/completions（F1 baseUrl应配置/v1）与GET /livez；TLS入口、唯一Bearer、请求/流/并发/截止有界。Node HTTPS固定目标、DNS全地址检查并固定本次解析IP，拒绝内网/元数据/loopback/重定向；测试私有HTTPS fixture仅程序化工厂注入，不作生产配置回退。

## 数据模型与授权

046新增model_credentials、model_runtime_grants、model_gateway_requests及无敏感正文的model_access_audit。FORCE RLS、默认无PUBLIC/应用直表权限。credential函数只接受可信API传入Principal（不是DB凭据泄露后的身份隔离层）；issuer与gateway单独EXECUTE权限，互不默认授予。

credential元数据：id/org/user/provider/label/version/status/createdAt/updatedAt；密文只在写入与已授权gateway准入内部流转，列表与响应不返回Key、密文、token、endpoint或正文。每人最多20条active凭据，列表固定上限50、无需无界分页。create服务端UUID，不声称未知结果可自动幂等重发；rotate/revoke必须expectedVersion，rotate或revoke使旧grant失效。审计记录创建、轮换、撤销、签发、准入、完成/失败，不存prompt、响应正文或凭据。

grant签发必须从agents/controls/run确认owner与active run，拒绝不存在、错误generation、已停止或治理漂移的运行，不新建Agent/run。F2隔离测试通过测试专用身份构造该数据，不插入业务演示记录。并发、计数与请求占位必须由DB原子完成，不能仅靠某个API进程的Map。gateway持久结果包含completed/failed/unknown和可空input/output token，不能作为最终账单。

## 协议和失败

入站JSON<=64KiB，messages/tools及常用chat字段固定允许，stream必须true、model必须等于grant绑定，max_tokens<=4096（缺失填受限默认），强制stream_options.include_usage=true。gateway不转发Cookie、任意Authorization或自定义上游地址。响应SSE累计<=4MiB、单事件<=256KiB、总时限<=120秒、并发<=16；遇不合法JSON/上游错误/响应超限/断开取消上游，返回固定错误，不回传Provider原始错误或重试。

模型正常文本/工具参数属于用户内容，网关不承诺通用秘密识别；至少对已知ProviderKey与本次Bearer做跨分片字面脱敏。usage仅接受Provider最终合法非负整数，缺失/冲突/中断标null或unknown，不估算字符token，不按模型目录价格扣款。最终持久化失败不得向下游发送成功终止标志；付费结果不确定须保留unknown，下一次不自动重放。

## API与运行

本人API前缀/api/user/model-credentials，默认404；显式开启且配置有效才可用，仅BetterAuth平台模式（测试注入除外）。GET列表、POST创建、PUT /:id轮换、DELETE /:id撤销，所有响应no-store；写请求严格同源、JSON、有界body、账号active，未知owner统一404。没有管理员代读他人Key或通用代理接口。

F2 gateway为独立入口，私有显式配置，生产TLS与受限PG；不加载业务.env或加入dev/preprod。API公钥配置与gateway私钥配置分开。F3将完成工具/控制Secret边界，F4才会将grant签发接入真实容器生命周期，F5提供页面。本批不声称F1同UID工具环境已安全上线。

## 验收

先RED再GREEN；真实RSA/GCM、AAD篡改、错Key、未来/过期/撤销/治理/代次/跨用户拒绝；一次性PostgreSQL受限角色/RLS/并发额度/迁移重跑；真实HTTPS/SSE fixture的工具事件、分片、usage、断开/超时/超限、密钥脱敏及上游无重试；凭据API启用/未启用/普通账号/管理员本人范围与Agent能力仍关闭；最终回归和独立规格→质量审查。真实Provider凭据及Linux常驻部署另行验收，不是本批先决条件。
