// 本机子进程形态（docs/32 §3.1）：以 `node wrapper.mjs` 在本机起实例，
// 用于开发与 CI，**无需 Docker**。生产请切换到 remote driver。

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeDriver, RuntimeDriverError, idOfSpec, sanitizeRef } from './runtime-driver.mjs';

const DEFAULT_WRAPPER_URL = new URL('../pi/wrapper.mjs', import.meta.url);

export class LocalProcessDriver extends RuntimeDriver {
  constructor(options = {}) {
    super(options);
    this.wrapperPath = options.wrapperPath
      ? fileURLToPath(options.wrapperPath)
      : fileURLToPath(DEFAULT_WRAPPER_URL);
  }

  get name() {
    return 'local';
  }

  canRun() {
    return { ok: true, reason: null };
  }

  async provision(spec = {}) {
    const agentId = idOfSpec(spec);
    if (!agentId) throw new RuntimeDriverError('agent_id_required', 'provision 需要 agentId');
    if (this.instances.has(agentId)) {
      const existing = this.instances.get(agentId);
      return { runtimeUrl: existing.runtimeUrl, ref: existing.ref, status: 'running', mode: this.name };
    }

    const port = await this.allocatePort();
    // 每个实例独立 workspace，便于 pi 会话/上下文落盘。
    let cwd = this.env.BAIRUI_PI_WORKSPACES ? join(this.env.BAIRUI_PI_WORKSPACES, sanitizeRef(agentId)) : null;
    if (cwd && !existsSync(cwd)) mkdirSync(cwd, { recursive: true });

    const child = spawn('node', [this.wrapperPath], {
      env: { ...this.env, ...(spec.env ?? {}), PORT: String(port) },
      cwd: cwd ?? tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[runtime:${agentId}] ` + chunk));
    child.on('error', (error) => console.error(`[runtime:${agentId}] spawn 失败：`, error.message));

    const runtimeUrl = `http://127.0.0.1:${port}`;
    await this.waitHealthy(runtimeUrl);
    const record = {
      agentId,
      driver: this.name,
      ref: String(child.pid),
      runtimeUrl,
      child,
      createdAt: new Date().toISOString(),
    };
    this.instances.set(agentId, record);
    return { runtimeUrl, ref: record.ref, status: 'running', mode: this.name };
  }

  async stop(spec = {}) {
    const agentId = idOfSpec(spec);
    const record = agentId ? this.instances.get(agentId) : null;
    if (!record) return { stopped: false, reason: 'not_found' };
    if (record.child) {
      try { record.child.kill('SIGTERM'); } catch { /* 已退出 */ }
    }
    this.instances.delete(agentId);
    return { stopped: true, ref: record.ref };
  }
}

export default LocalProcessDriver;
