// 运行时编排抽象层（docs/32 §3.1 阶段 A）。
//
// 平台级形态下，Agent Runtime 实例不再由 platform-api / worker 通过 `docker run`
// 在宿主拉起，也不再挂载 /var/run/docker.sock —— 挂 docker.sock 等于把宿主
// Docker 的完全控制权交给服务，任一租户都可能借此逃逸到宿主 root。
//
// RuntimeDriver 把「如何把实例跑起来 / 停掉 / 探活」从引擎协议中剥离：
//   - local  ：本机子进程（开发 / CI，无需 Docker）；
//   - remote ：实例由外部编排（K8s / Swarm / 运行时池）拉起，平台只登记
//              runtimeUrl、健康检查、路由与回收通知。
// 引擎适配器（pi-engine 等）只负责信封协议与对话，不再感知编排差异。

import { createServer } from 'node:net';

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * driver 契约方法同时接受 spec 对象或裸 agentId。
 * 取不到 id 时返回 null（而非把 spec 本身当 id），便于调用方统一判空。
 */
export function idOfSpec(spec) {
  const id = spec?.agentId ?? spec?.id;
  if (id !== undefined && id !== null) return id;
  return typeof spec === 'string' && spec ? spec : null;
}

export function sanitizeRef(id) {
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 60);
}

export class RuntimeDriverError extends Error {
  // message 带 [code] 前缀：日志里既能读中文原因，也能按错误码检索。
  constructor(code, message, options = {}) {
    super(`[${code}] ${message}`);
    this.name = 'RuntimeDriverError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export class RuntimeDriver {
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.allocatePort = options.allocatePort ?? freePort;
    this.spawnTimeoutMs = Number(options.spawnTimeoutMs ?? this.env.BAIRUI_ENGINE_SPAWN_TIMEOUT_MS ?? 120000);
    // 实例登记表：agentId -> { agentId, driver, ref, runtimeUrl, createdAt }
    // 进程内存态；平台级形态由 agent_engine_runs 落库作为权威状态（docs/32 阶段 C）。
    this.instances = new Map();
  }

  /** driver 名称，写入实例记录便于排障。 */
  get name() {
    return 'abstract';
  }

  /** 该 driver 在当前环境下是否可用；不可用时解析器统一回退 mock。 */
  canRun() {
    return { ok: false, reason: 'abstract driver 不可直接使用' };
  }

  async provision(spec = {}) {
    throw new RuntimeDriverError('driver_not_implemented', `${this.name} driver.provision() 未实现`);
  }

  async stop(spec = {}) {
    const agentId = idOfSpec(spec);
    const record = agentId ? this.instances.get(agentId) : null;
    if (!record) return { stopped: false, reason: 'not_found' };
    this.instances.delete(agentId);
    return { stopped: true, ref: record.ref };
  }

  async health(spec = {}) {
    const agentId = idOfSpec(spec);
    const record = agentId ? this.instances.get(agentId) : null;
    if (!record) return { status: 'unknown', driver: this.name };
    try {
      const response = await this.fetchImpl(record.runtimeUrl + '/healthz');
      return { status: response.ok ? 'running' : 'degraded', driver: this.name, runtimeUrl: record.runtimeUrl };
    } catch {
      return { status: 'offline', driver: this.name, runtimeUrl: record.runtimeUrl };
    }
  }

  route(spec = {}) {
    const agentId = idOfSpec(spec);
    const record = agentId ? this.instances.get(agentId) : null;
    return { runtimeUrl: record?.runtimeUrl ?? null };
  }

  /** 轮询实例 /healthz 直至就绪，超时抛错。 */
  async waitHealthy(runtimeUrl) {
    const deadline = Date.now() + this.spawnTimeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const response = await this.fetchImpl(runtimeUrl + '/healthz');
        if (response.ok) return;
        lastError = 'healthz ' + response.status;
      } catch (error) {
        lastError = error.message;
      }
      await wait(400);
    }
    throw new RuntimeDriverError('instance_unhealthy', `实例在 ${this.spawnTimeoutMs}ms 内未就绪：${lastError ?? 'unknown'}`);
  }
}

export default RuntimeDriver;
