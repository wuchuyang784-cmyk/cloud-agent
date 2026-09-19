export function platformCapabilities(env = process.env) {
  const mode = env.BAIRUI_PLATFORM_MODE ?? 'platform';
  if (!['platform', 'legacy'].includes(mode)) throw new Error('BAIRUI_PLATFORM_MODE must be platform or legacy');
  if (mode === 'legacy' && env.NODE_ENV === 'production') throw new Error('legacy mode is forbidden in production');
  const enabled = mode === 'legacy';
  return Object.freeze({ mode, agentLifecycle: enabled, agentExecution: enabled, simulatedRecharge: enabled });
}

export function validatePlatformStartup(env = process.env) {
  const capabilities = platformCapabilities(env);
  if (capabilities.mode === 'platform') {
    if (env.BAIRUI_AUTH_MODE !== 'better-auth') throw new Error('Platform mode requires BAIRUI_AUTH_MODE=better-auth');
    if (!env.DATABASE_URL) throw new Error('Platform mode requires PostgreSQL: set DATABASE_URL');
  }
  return capabilities;
}

export function assertAgentRuntimeEnabled(env = process.env) {
  if (!platformCapabilities(env).agentExecution) throw new Error('agent_runtime_disabled: platform mode cannot start Agent Worker or Runtime');
}

export function disabledCapability(capabilities, method, path) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  if (path === '/api/user/agents' || path.startsWith('/api/user/agents/')) {
    const capability = path.includes('/sessions') ? 'agentExecution' : 'agentLifecycle';
    if (!capabilities[capability]) return capability;
  }
  if (path === '/api/user/billing/recharge' && !capabilities.simulatedRecharge) return 'simulatedRecharge';
  return null;
}
