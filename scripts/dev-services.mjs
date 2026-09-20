import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { platformCapabilities, validatePlatformStartup } from '../apps/platform-api/src/platform-config.mjs';

export function developmentServices(env, target = 'all') {
  if (!['all', 'api', 'web'].includes(target)) throw new Error('Unknown development target');
  const capabilities = target === 'web' ? platformCapabilities(env) : validatePlatformStartup(env);
  const services = [];
  if (target !== 'web') {
    services.push({ name: 'platform-api', directory: 'apps/platform-api', entry: 'src/index.mjs', port: env.PLATFORM_API_PORT || '8080' });
    if (capabilities.agentExecution) services.push(
      { name: 'platform-worker', directory: 'apps/platform-api', entry: 'src/worker-index.mjs' },
      { name: 'mock-runtime', directory: 'apps/platform-api', entry: 'src/mock-runtime-server.mjs', port: env.MOCK_RUNTIME_PORT || '8090' },
      { name: 'runtime-boundary', directory: 'apps/platform-api', entry: 'src/runtime/boundary-server.mjs', port: env.RUNTIME_BOUNDARY_PORT || '8091' },
    );
  }
  if (target !== 'api') services.push(
    { name: 'admin-console', directory: 'apps/admin-console', entry: 'node_modules/vite/bin/vite.js', listenPort: env.ADMIN_CONSOLE_PORT || '5174' },
    { name: 'console-mvp', directory: 'apps/console-mvp', entry: 'node_modules/vite/bin/vite.js', listenPort: '5173' },
  );
  return services.map(service => service.port ? { ...service, listenPort: service.port } : service);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(developmentServices(process.env, process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
