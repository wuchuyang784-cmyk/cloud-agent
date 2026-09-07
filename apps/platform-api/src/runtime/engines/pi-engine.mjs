// pi-agent 引擎适配器骨架（docs/27 §2.1 / docs/28 §2/§3.1）。
// 落地路径：填充 spawn/stop/health/route/validate，指向 pi 基线镜像
// （bairui-agent-pi，PI_PROVIDER/PI_MODEL/PI_API_KEY 注入见 docs/28 §3.2），
// 并在容器编排就绪后放开 canRun()。放开前本类只作为契约占位。

import { notImplemented } from './contract.mjs';

export class PiEngineAdapter {
  constructor(options = {}) {
    this.engine = 'pi';
    this.env = options.env ?? process.env;
  }

  canRun() {
    if (!this.env.BAIRUI_ENGINE_PI_IMAGE) {
      return { ok: false, reason: 'BAIRUI_ENGINE_PI_IMAGE 未配置，pi 引擎不可用' };
    }
    return { ok: false, reason: 'pi adapter 待实现（镜像/编排接入中）' };
  }

  async spawn() { return notImplemented(this.engine, 'spawn'); }
  async stop() { return notImplemented(this.engine, 'stop'); }
  async health() { return notImplemented(this.engine, 'health'); }
  async route() { return notImplemented(this.engine, 'route'); }
  async validate() { return { ok: false, errors: ['pi adapter manifest 校验未实现'] }; }
}
