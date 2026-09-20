# 本地开发使用 PostgreSQL

> docs/32：本机 Docker **只保留数据库这一个服务**。平台 api / worker / boundary
> 一律以本机 node 进程直接运行，不再部署 docker stack，也不再挂载 docker.sock，
> 更不会由平台 `docker run` 拉起 Agent 实例 —— 实例编排改由 `BAIRUI_RUNTIME_DRIVER`
> 决定，local 形态也是本机子进程（见 `docs/32-platform-grade-architecture.md`）。
>
> 若本机留有历史遗留的应用容器，先列清单、确认后再移除，**保留 `bairui-postgres`**：
> ```powershell
> # 1) 列清单（确认哪些要删）
> docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
> # 2) 逐个移除（-f 会同时停止运行中的容器）；不要删 bairui-postgres
> docker rm -f <容器名>
> # 例：移除历史 pi 实例容器  docker rm -f bairui-pi-agent-xxx
> ```

平台 API 已支持 PostgreSQL。准备好数据库后，使用迁移角色按顺序导入
`packages/db/migrations/` 下的全部迁移：`001_platform_mvp.sql`、
`022_agent_templates.sql`、`023_auth_sessions.sql`、`024_worker_rls.sql`、
`025_client_resources.sql`、`026_conversation_messages.sql`、
`027_client_resource_contents.sql`、`028_agent_user_features.sql`、
`029_agent_engine_rls.sql`、`030_agent_engine_mock_default.sql` 和
`031_multi_organization_reservations.sql`（仓库基线无 002-021 号迁移），
然后把连接串写入仓库根目录的 `.env`（`npm run setup:env` 可直接生成，`.env` 不进 git）。
API 与 Worker 必须共用同一个连接串：用根目录 `npm run dev` 时由脚本统一注入；手工分别启动时，
两边进程都要能读到 `DATABASE_URL`，否则会出现一边落库、一边走内存的错配。

应用连接建议使用已创建的非超级用户 `bairui_app`，连接目标为 `bairui` 数据库：

```powershell
$env:DATABASE_URL = 'postgresql://bairui_app:你的密码@127.0.0.1:5432/bairui'
```

不要把实际密码写入 PowerShell 历史、`.env` 示例、代码或 Git。未设置
`DATABASE_URL` 时应用才回退到只适合单进程测试的 `MemoryStore`。

一种本地 Docker 启动方式：

```powershell
docker run --name bairui-postgres `
  -e POSTGRES_USER=bairui `
  -e POSTGRES_PASSWORD=change-me-local-only `
  -e POSTGRES_DB=bairui `
  -p 5432:5432 `
  -d postgres:17-alpine
```

在仓库根目录逐个导入数据库结构（示例导入 `001`）：

```powershell
docker cp packages/db/migrations/001_platform_mvp.sql bairui-postgres:/tmp/001.sql
docker exec bairui-postgres psql -U bairui -d bairui -f /tmp/001.sql
```

其余迁移同样逐个执行（`022_agent_templates.sql` 至 `031_multi_organization_reservations.sql`）。
使用 `docker cp` + `psql -f` 可避免管道命令对中文注释的编码转码问题；迁移文件需为
UTF-8（无 BOM）。

如果数据库不是 Docker 容器，请在 Navicat 中以迁移账号执行全部迁移文件，或使用
你现有的 PostgreSQL 客户端逐个执行。

即使在本地 Swarm 环境运行，也要为 `BAIRUI_SESSION_SECRET` 使用随机生成的
密钥。不要将数据库 URL 或会话密钥提交到代码仓库。
