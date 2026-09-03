# C00-03 PostgreSQL 控制模型候选证据

> 状态：`C00-03 = PENDING (canonical integration candidate verified)`
>
> Gate：`GATE-C00 = PENDING`
>
> 验证日期：2026-07-18

## 1. 结论

本候选实现已经建立可执行的 PostgreSQL Authority 持久化内核，并在真实 Linux/Docker
服务器的隔离 PostgreSQL 17 中完成迁移、schema 检查、新链路集成测试和旧链路回归测试。

Platform main 已消费固定的 `@bairui/contracts v2.3.0-rc.2`，本分支也已把 PostgreSQL
Authority 接入生产启动组合，并把 lease/receipt HTTP 入口统一为 canonical `/leases` 和
`/receipts`。旧 command-prefixed 路径不再调用 Authority；所有 wire 到数据库的字段转换
只发生在显式 canonical adapter 中。

rc.2 canonical adapter 的强约束也在运行路径生效：DesiredState 使用 `status` 与
`target_state`，Observation 使用 `observation_version`、`freshness` 与 `components`，
命令只接受 `sr_...` opaque secret reference；非审批命令拒绝 `approval_id`。由于 Contracts
的 LeaseEnvelope 将一个 `lease_id` 绑定到所有 commands，而 PostgreSQL 当前按 command
保存一次性 lease，本候选每个 canonical lease envelope 最多发放一个 command，避免批量
返回多个不一致的 lease identity。

它仍不能把 `C00-03` 标记为 `DONE`：本迁移尚未应用到生产数据库，本分支尚未推送并取得
GitHub PostgreSQL job 证据，BaiRui-agent 仍需固定消费相同 Contracts 版本，而且
completion candidate 到 post-action Observation 的后台验证调度尚未成为生产 worker。

干净集成分支已经把 `tests/postgres-control-authority.test.mjs` 接入现有 GitHub
`postgres-migrations` job，并让 `check-platform.mjs` 登记 C00-03 migration、repository、service、
tests 和证据文档。由于分支按要求未推送，这只能证明 CI wiring 已存在，不能冒充 GitHub CI 已运行。

在这些差距关闭前，不能宣称 `C00-03 DONE`，更不能宣称 `GATE-C00 PASS`。

## 2. 写入范围

| 范围 | 文件 | 作用 |
| --- | --- | --- |
| Migration | `packages/db/migrations/021_control_authority_model.sql` | 表、约束、索引、触发器和 JSON 安全策略 |
| Policy | `packages/control-authority/policy.mjs` | 固定 action、字段闭集、正文/密钥拒绝、审计脱敏和稳定摘要 |
| Service | `packages/control-authority/service.mjs` | C00-02 canonical envelope 到持久化命令的严格输入边界 |
| Repository | `packages/db/control-authority-repository.mjs` | PostgreSQL 事务、状态机、租约、验证、outbox 和分页聚合 |
| Schema check | `scripts/check-postgres-schema.mjs` | 检查 021 表、字段、函数和触发器 |
| Static test | `tests/control-authority-schema.test.mjs` | 闭集、安全策略和终态规则 |
| Integration test | `tests/postgres-control-authority.test.mjs` | 真实 PostgreSQL Authority 闭环 |

没有修改 BaiLongma/UI、Runtime/Hermes 或 Contracts 源码；Server Agent 仅切换到 canonical
lease/receipt HTTP 路径并消费 `v2.3.0-rc.2` envelope。

## 3. 一等持久化模型

### 3.1 已有实体的收敛

- `desired_states`
  - 新增 owner scope、request/correlation/idempotency、sequence、目标 state、生命周期、modules 和 valid-from。
  - 同一 deployment 只允许一个 `active` revision。
  - 兼容触发器为旧 provisioning 自动补 scope，并原子把上一版改为 `superseded`。
- `observations`
  - 新增 owner scope、单调 sequence、source identity、modules、redaction status 和 freshness。
  - stale version/sequence 不能覆盖新事实。
- `control_events`
  - 持久化 request/correlation/idempotency、attempt、lease、observation version 和 source identity。
  - 每个 deployment 使用严格递增 event sequence，可重放。
- `control_approvals`
  - 持久化 owner scope、action、reason code/ref 和审批 scope。
- `release_manifests`
  - 持久化 channel、Contracts 版本、immutable 标记、digest 固定 artifacts 和 evidence refs。
- `control_commands` / `command_receipts`
  - 新增 opaque `secret_refs`、`verification_state`、completion candidate、finalized time 和 receipt idempotency。

### 3.2 新实体

- `control_secret_references`
  - 只保存随机 reference ID、purpose、version、state、masked hint 和 SHA-256 fingerprint。
  - 不保存 API key、token、password、secret envelope 或可还原值。
- `control_command_leases`
  - 保存 command/server/attempt 绑定、token hash、TTL 和 consumed/expired/revoked 状态。
  - 原始 lease token 只在签发结果中出现一次，数据库只保存 SHA-256。
- `command_verifications`
  - 接收 Server Agent 的 canonical `completion_candidate` receipt，并映射到 Authority 的验证候选。
  - command 先进入 `verifying/checking`；只有 Authority 读取更新且新鲜的 Observation、核对
    DesiredState version 和 evidence refs 后，才能派生最终 `succeeded/verified`。
- `control_idempotency_records`
  - 保存 namespace、request hash、aggregate 和 result ref。
  - 相同 key + 相同请求返回原结果；相同 key + 不同请求返回 `idempotency_conflict`。
- `control_audit_events`
  - 每组织单调 sequence、previous hash 和 event hash，形成 append-only 审计链。

### 3.3 Outbox 与 dead letter

每次 Authority 状态变化在同一 PostgreSQL 事务中写入：

```text
aggregate mutation
  + control_event
  + control_outbox
  + control_audit_event
  + idempotency result
```

Outbox 状态为：

```text
pending/retry -> processing -> published
processing -> retry -> processing
retry at max attempts -> dead_letter
```

Publisher lease 同样只持久化 token hash，并有 TTL。过期 publisher lease 回到 `retry`，不会
静默丢消息。

## 4. 数据边界

应用策略与 PostgreSQL trigger 双重拒绝以下控制 payload key：

```text
prompt, system_prompt, chat, conversation, message, task,
model, provider, tool, skill, memory,
password, token, api_key, secret, secret_envelope, credential,
authorization, shell, script, sql
```

控制面允许的是 ID、版本、状态、数值指标、错误码、脱敏摘要、digest 和 evidence/reference。
外部 Observation summary、Receipt result 和 Verification checks 进一步只允许数字、布尔、ID、
digest、时间戳和 opaque reference，不能用自由文本字段伪装聊天或任务正文。Receipt 的错误摘要
由固定 error code 派生，不持久化调用方提供的自由文本。JSON 文本有长度上限，并拒绝
Private Key、Bearer token 和常见 API key 形状。数据库 trigger
覆盖 DesiredState、Observation、Command arguments、Receipt、Approval、Event、Release、
Verification、Outbox、dead letter 和 control audit。

## 5. 状态机

新 Authority 路径执行：

```text
queued -> leased -> accepted -> running -> verifying -> succeeded
                                      \-> failed/cancelled/expired
```

关键不变量：

1. `leased -> succeeded` 被拒绝。
2. `accepted -> succeeded` 被拒绝。
3. `running -> completion_candidate receipt` 只生成 `verifying/checking`，外部 `succeeded` 被拒绝。
4. lease 绑定 organization/agent/server/deployment/command/attempt，过期或跨 scope receipt 被拒绝。
5. terminal receipt 消费 lease；使用新 idempotency key 重用 token 被拒绝。
6. 已完成请求使用原 idempotency key重放时返回原结果，不重复推进状态。
7. `verified` 必须使用更新的、健康的、fresh 的 Observation，匹配 active DesiredState version，
   且 receipt 与 verification 都有 evidence refs。
8. 高风险 action 需要 Approval，发起人不能批准自己的同一请求。

## 6. 管理员读取模型

`listDeploymentAggregates()` 提供 keyset pagination，并只返回：

- organization、owner user、Agent、server 和 deployment ID；
- 最新 DesiredState 摘要；
- 最新 Observation、freshness 和 evidence refs；
- queued/verifying/failed command 数量；
- deployment health、desired/observed version 和更新时间。

它不查询 conversations、messages、Agent runs、Obsidian Markdown 或 Hermes 工作区正文。

## 7. 真实服务器验证

验证主机：`38.76.190.182`，Linux `6.8.0-136-generic`，Docker `29.1.3`。

隔离方式：

- 临时容器：`postgres:17-alpine`
- 仅绑定回环地址：`127.0.0.1:55439`
- 独立数据库：`bairui_c00_03_r2`
- 未访问生产 PostgreSQL、Platform、Nginx 或 Caddy
- 验证结束后临时 PostgreSQL 容器和 `/tmp` 测试目录均已删除

结果：

| 验证 | 结果 |
| --- | --- |
| 全迁移 `001 -> 021` | PASS，21 个 migration 全部 Applied |
| Schema check | PASS，`PostgreSQL schema check passed.` |
| C00-03 Authority integration | PASS，1/1 |
| 现有 PostgreSQL control regression | PASS，2/2 |
| Migration checksum replay | PASS，21 个 migration 全部 Verified |
| 静态安全/状态机测试 | PASS，7/7 |

第一次真实测试暴露并修复了两个问题：

1. JavaScript array 需要显式 JSON 序列化后写入 `jsonb`。
2. 旧 provisioning retry 需要兼容触发器先 supersede 上一版 DesiredState。

这两个问题都在重新创建的干净数据库中复测通过。

## 8. 服务器验收命令

以下命令必须针对隔离或预发布 PostgreSQL 执行，不能先在生产库试跑：

```bash
export DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/BAIRUI_STAGING'

npm ci --ignore-scripts
npm run db:migrate
npm run db:schema:check

BAIRUI_POSTGRES_INTEGRATION=1 \
  node --test tests/postgres-control-authority.test.mjs

BAIRUI_POSTGRES_INTEGRATION=1 \
  node --test tests/postgres-control.test.mjs

# 验证 migration checksum 未漂移
npm run db:migrate
```

最低 SQL 证据：

```sql
SELECT name, checksum, applied_at
FROM schema_migrations
WHERE name = '021_control_authority_model.sql';

SELECT proname
FROM pg_proc
WHERE proname IN (
  'bairui_control_json_is_safe',
  'bairui_reject_unsafe_control_json',
  'bairui_prepare_desired_state_revision'
);

SELECT tgname
FROM pg_trigger
WHERE NOT tgisinternal
  AND tgname IN (
    'desired_states_prepare_revision',
    'control_commands_safe_payload',
    'command_receipts_safe_payload',
    'control_outbox_safe_payload',
    'control_audit_events_safe_payload'
  );
```

## 9. C00-03 解锁条件

只有以下条件全部完成，才可把 Agent 计划中的 `C00-03` 从 `PENDING` 改成 `DONE`：

1. BaiRui-agent 与 Platform/Server Agent 固定消费同一个 Contracts 发布版本。
2. completion candidate 到 post-action Observation 的验证调度以后台 worker 方式闭环。
3. 生产候选发布包固定 migration `021_control_authority_model.sql` 和不可变镜像 digest。
4. GitHub PostgreSQL job 在分支推送后真实执行新集成测试和旧回归测试；当前仅完成 workflow wiring。
5. 预发布数据库备份、升级、回滚恢复和发布后 observation 验证通过。

本候选没有更新 `C00-03` 或 `GATE-C00` 状态。
