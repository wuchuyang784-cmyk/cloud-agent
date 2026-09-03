# 本地开发使用 PostgreSQL

平台 API 已支持 PostgreSQL。准备好数据库后，使用迁移角色按顺序导入
`001_platform_mvp.sql`、`022_agent_templates.sql`、`023_auth_sessions.sql` 和
`024_worker_rls.sql`，然后为 API 和 Worker 服务设置同一个 `DATABASE_URL`。

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

在仓库根目录导入数据库结构：

```powershell
Get-Content packages/db/migrations/001_platform_mvp.sql | docker exec -i bairui-postgres psql -U bairui -d bairui
```

如果数据库不是 Docker 容器，请在 Navicat 中以迁移账号执行四个迁移文件，或使用
你现有的 PostgreSQL 客户端逐个执行。

即使在本地 Swarm 环境运行，也要为 `BAIRUI_SESSION_SECRET` 使用随机生成的
密钥。不要将数据库 URL 或会话密钥提交到代码仓库。
