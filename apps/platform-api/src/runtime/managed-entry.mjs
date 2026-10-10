// Independent managed process; never part of the platform API or dev chain.
import { pathToFileURL } from 'node:url';
import { loadManagedRuntimeEnvironment } from './managed-config.mjs';

export async function startManagedRuntime(kind, inheritedEnv = process.env) {
  if (!['controller', 'orchestrator'].includes(kind)) throw new Error('runtime_managed_kind_invalid');
  const env = await loadManagedRuntimeEnvironment(inheritedEnv);
  const mode = kind === 'controller' ? env.BAIRUI_RUNTIME_CONTROLLER_MODE : env.BAIRUI_ORCHESTRATOR_MODE;
  if (mode !== 'managed') throw new Error('runtime_managed_mode_required');
  if (kind === 'controller') {
    const { startRuntimeController } = await import('./supervision/index.mjs');
    return startRuntimeController(env);
  }
  const { startOrchestrator } = await import('./orchestrator/index.mjs');
  return startOrchestrator(env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('runtime_managed_kind_invalid');
    const instance = await startManagedRuntime(process.argv[2]);
    console.log('runtime_managed_ready');
    let closing;
    const stop = () => {
      closing ??= instance.close().catch(() => { console.error('runtime_managed_shutdown_failed'); process.exitCode = 1; });
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch { console.error('runtime_managed_start_failed'); process.exitCode = 1; }
}
