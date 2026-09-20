// 远程编排形态（docs/32 §3.1，平台级生产的默认形态）。
//
// 实例由外部编排系统（K8s / Docker Swarm / 运行时池）拉起，平台侧只负责：
//   1) 需要时向编排器请求拉起，拿到 runtimeUrl 后登记；
//   2) 健康检查、路由、回收通知。
//
// 平台不碰 docker.sock，也不执行 docker run —— 资源限制、非 root、只读根
// 文件系统等加固全部由编排层的容器规格负责（如 K8s Pod 的 securityContext
// 与 resources.limits），天然满足 docs/28 §沙箱要求。

import { RuntimeDriver, RuntimeDriverError, idOfSpec } from './runtime-driver.mjs';

export class RemoteRuntimeDriver extends RuntimeDriver {
  constructor(options = {}) {
    super(options);
    this.orchestratorUrl = options.orchestratorUrl
      ?? this.env.BAIRUI_RUNTIME_ORCHESTRATOR_URL
      ?? null;
  }

  get name() {
    return 'remote';
  }

  canRun() {
    if (this.orchestratorUrl) return { ok: true, reason: null };
    return { ok: false, reason: 'BAIRUI_RUNTIME_ORCHESTRATOR_URL 未配置，remote driver 不可用' };
  }

  async provision(spec = {}) {
    const canRun = this.canRun();
    if (!canRun.ok) throw new RuntimeDriverError('remote_driver_unavailable', canRun.reason);

    const agentId = idOfSpec(spec);
    if (!agentId) throw new RuntimeDriverError('agent_id_required', 'provision 需要 agentId');
    if (this.instances.has(agentId)) {
      const existing = this.instances.get(agentId);
      return { runtimeUrl: existing.runtimeUrl, ref: existing.ref, status: 'running', mode: this.name };
    }

    const response = await this.fetchImpl(this.orchestratorUrl + '/instances', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, engine: spec.engine ?? 'pi', env: spec.env ?? {} }),
    });
    if (!response.ok) {
      throw new RuntimeDriverError('orchestrator_rejected', `编排器拉起实例失败：HTTP ${response.status}`);
    }
    const data = await response.json().catch(() => null);
    const runtimeUrl = data?.runtimeUrl;
    if (!runtimeUrl) throw new RuntimeDriverError('orchestrator_bad_response', '编排器未返回 runtimeUrl');

    await this.waitHealthy(runtimeUrl);
    const record = {
      agentId,
      driver: this.name,
      ref: data?.ref ?? null,
      runtimeUrl,
      createdAt: new Date().toISOString(),
    };
    this.instances.set(agentId, record);
    return { runtimeUrl, ref: record.ref, status: 'running', mode: this.name };
  }

  async stop(spec = {}) {
    const agentId = idOfSpec(spec);
    const record = agentId ? this.instances.get(agentId) : null;
    if (!record) return { stopped: false, reason: 'not_found' };
    try {
      await this.fetchImpl(`${this.orchestratorUrl}/instances/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    } catch (error) {
      console.error(`[runtime:${agentId}] 通知编排器停止失败：`, error.message);
    }
    this.instances.delete(agentId);
    return { stopped: true, ref: record.ref };
  }
}

export default RemoteRuntimeDriver;
