// 运行时编排工厂（docs/32 §3.1）：按 BAIRUI_RUNTIME_DRIVER 选择 driver。
//   local  —— 本机子进程，开发 / CI 默认，无需 Docker；
//   remote —— 外部编排拉起实例，平台级生产形态（不碰 docker.sock）。

import { LocalProcessDriver } from './local-driver.mjs';
import { RemoteRuntimeDriver } from './remote-driver.mjs';

export const RUNTIME_DRIVER_KINDS = Object.freeze(['local', 'remote']);

export function createRuntimeDriver(options = {}) {
  const env = options.env ?? process.env;
  const kind = String(options.driver ?? env.BAIRUI_RUNTIME_DRIVER ?? 'local').toLowerCase();
  if (kind === 'remote') return new RemoteRuntimeDriver({ ...options, env });
  if (kind === 'local') return new LocalProcessDriver({ ...options, env });
  throw new Error(`未知的 BAIRUI_RUNTIME_DRIVER="${kind}"，可选：${RUNTIME_DRIVER_KINDS.join(' | ')}`);
}

export { RuntimeDriver, RuntimeDriverError, idOfSpec } from './runtime-driver.mjs';
export { LocalProcessDriver } from './local-driver.mjs';
export { RemoteRuntimeDriver } from './remote-driver.mjs';
