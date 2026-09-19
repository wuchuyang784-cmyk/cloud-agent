// pi-agent 引擎适配器（docs/27 §2.1 / docs/28 §2 / docs/31 §5 / docs/32 §3.1）。
//
// 一个 pi Agent = 一个独立实例：平台 wrapper（runtime/pi/wrapper.mjs）
// + 常驻 `pi --mode rpc --no-session` 子进程。wrapper 只读真实 provider env
// （如 DEEPSEEK_API_KEY），不存在 PI_API_KEY（docs/31 §4.4）。
//
// 实例的拉起 / 停止 / 探活统一交给 RuntimeDriver（docs/32 §3.1）：
// 平台不再执行 `docker run`，也不再挂载 /var/run/docker.sock —— 挂 docker.sock
// 等于把宿主 Docker 的完全控制权交给服务，任一租户都可能逃逸到宿主 root。
//   - local  ：BAIRUI_RUNTIME_DRIVER=local 且 BAIRUI_PI_LOCAL=1，本机 node wrapper 子进程；
//   - remote ：BAIRUI_RUNTIME_DRIVER=remote，实例由外部编排拉起，平台登记 runtimeUrl。
//
// 对话请求以信封头签名下发（boundary-envelope.mjs），wrapper 校验后执行。

import { envelopeHeaders } from '../boundary-envelope.mjs';
import { createRuntimeDriver } from '../orchestration/index.mjs';
import { idOfSpec } from '../orchestration/runtime-driver.mjs';

const PROVIDER_KEY_ENVS = [
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GOOGLE_API_KEY',
  'MISTRAL_API_KEY',
];

export class PiEngineAdapter {
  constructor(options = {}) {
    this.engine = 'pi';
    this.env = options.env ?? process.env;
    this.sharedSecret = options.sharedSecret ?? this.env.RUNTIME_SHARED_SECRET ?? 'local-dev-change-me';
    // 编排与协议分离：driver 负责实例生命周期，adapter 只负责信封协议与对话。
    this.driver = options.driver ?? createRuntimeDriver({ env: this.env, ...options.driverOptions });
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  canRun() {
    const capability = this.driver.canRun();
    if (!capability.ok) return capability;
    // 本机形态需显式启用：docker 形态（BAIRUI_ENGINE_PI_IMAGE）已在 docs/32 阶段 A 移除，
    // 未显式启用时保持「回退 mock」的既有默认，避免开发机无 pi 二进制时拉起失败。
    if (this.driver.name === 'local' && !this.env.BAIRUI_PI_LOCAL) {
      return { ok: false, reason: 'pi 本机形态需设 BAIRUI_PI_LOCAL=1（docker 形态已移除，见 docs/32 §3.1）' };
    }
    return { ok: true, reason: null };
  }

  #buildInstanceEnv(spec) {
    const agentId = idOfSpec(spec);
    const env = {
      AGENT_ID: agentId,
      AGENT_ENGINE: 'pi',
      SUBDOMAIN: `agent-${agentId}.localhost`,
      RUNTIME_SHARED_SECRET: this.sharedSecret,
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
    };
    if (spec?.provider) env.PI_PROVIDER = spec.provider;
    else if (this.env.PI_PROVIDER) env.PI_PROVIDER = this.env.PI_PROVIDER;
    if (spec?.model) env.PI_MODEL = spec.model;
    else if (this.env.PI_MODEL) env.PI_MODEL = this.env.PI_MODEL;
    if (spec?.manifest) env.TEMPLATE_MANIFEST = JSON.stringify(spec.manifest);
    for (const key of PROVIDER_KEY_ENVS) {
      if (this.env[key]) env[key] = this.env[key];
    }
    return env;
  }

  async spawn(spec = {}) {
    const canRun = this.canRun();
    if (!canRun.ok) throw new Error('pi_engine_unavailable: ' + canRun.reason);
    const agentId = idOfSpec(spec);
    if (!agentId) throw new Error('agent id required to spawn pi instance');
    const result = await this.driver.provision({ ...spec, agentId, env: this.#buildInstanceEnv(spec) });
    return {
      runtimeUrl: result.runtimeUrl,
      containerRef: result.ref,
      status: result.status ?? 'running',
      mode: result.mode ?? this.driver.name,
    };
  }

  // 兼容短回路调用（worker/app 使用 runtime.provision(agent)）。
  async provision(spec = {}) {
    const result = await this.spawn(spec);
    return { runtimeUrl: result.runtimeUrl };
  }

  async health(spec = {}) {
    return this.driver.health(spec);
  }

  route(spec = {}) {
    return this.driver.route(spec);
  }

  async stop(spec = {}) {
    return this.driver.stop(spec);
  }

  validate(manifest = null) {
    const errors = [];
    if (manifest && manifest.engine && manifest.engine !== 'pi') {
      errors.push('manifest 目标引擎不是 pi');
    }
    return { ok: errors.length === 0, errors };
  }

  // 短回路对话：把一次 user 消息以信封头签名 POST 到该实例 wrapper 的 /v1/tasks。
  async streamChat({ agent, message, writeEvent = () => {} }) {
    // 路由优先取 driver 登记表（本进程拉起的实例），其次取落库的 runtimeUrl
    // （由 worker 或编排层登记，平台重启后仍可对话）。
    const routed = agent?.id ? this.driver.route({ agentId: agent.id }) : { runtimeUrl: null };
    const runtimeUrl = routed.runtimeUrl ?? agent?.runtimeUrl;
    if (!runtimeUrl) throw new Error('pi instance for agent not provisioned');
    const raw = JSON.stringify({ prompt: message, reset: true });
    const headers = envelopeHeaders({ secret: this.sharedSecret, body: raw });
    const response = await this.fetchImpl(runtimeUrl + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw,
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('pi wrapper returned non-json (' + response.status + ')');
    }
    if (!response.ok || data?.error) {
      throw new Error('pi task failed: ' + (data?.detail ?? data?.error ?? response.status));
    }
    const content = data?.content ?? '';
    writeEvent('run.started', { agentId: agent?.id, engine: 'pi' });
    writeEvent('message.completed', { role: 'assistant', content });
    const totalTokens = Number(data?.totalTokens ?? content.length);
    writeEvent('run.completed', { usage: { totalTokens } });
    return { totalTokens, engine: 'pi', runtimeUrl };
  }
}

export default PiEngineAdapter;
