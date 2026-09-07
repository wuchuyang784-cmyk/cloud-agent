// deepseek-harness 引擎适配器骨架（docs/27 §2.2 / docs/28 §2/§3.1）。
// 落地路径：填充 spawn/stop/health/route/validate，指向 dsh 基线镜像
// （bairui-agent-dsh，DSH_PROFILE/DSH_PRESET/DSH_API_KEY 注入见 docs/28 §3.2），
// 并在容器编排就绪后放开 canRun()。放开前本类只作为契约占位。

import { ENGINE_KINDS, notImplemented } from './contract.mjs';

export class DshEngineAdapter {
  constructor(options = {}) {
    this.engine = 'dsh';
    this.env = options.env ?? process.env;
  }

  canRun() {
    if (!this.env.BAIRUI_ENGINE_DSH_IMAGE) {
      return { ok: false, reason: 'BAIRUI_ENGINE_DSH_IMAGE 未配置，dsh 引擎不可用' };
    }
    return { ok: false, reason: 'dsh adapter 待实现（镜像/编排接入中）' };
  }

  async spawn() { return notImplemented(this.engine, 'spawn'); }
  async stop() { return notImplemented(this.engine, 'stop'); }
  async health() { return notImplemented(this.engine, 'health'); }
  async route() { return notImplemented(this.engine, 'route'); }
  async validate() { return { ok: false, errors: ['dsh adapter manifest 校验未实现'] }; }
}
