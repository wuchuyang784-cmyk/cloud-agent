import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

async function boundedFile(path, limit) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error();
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) throw new Error();
    const buffer = Buffer.alloc(limit + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

export async function loadBusinessMonitoringEnv(env) {
  if (!env.BAIRUI_ADMIN_MONITORING_CONFIG_FILE) return { ...env };
  try {
    if (env.NODE_ENV === 'production') throw new Error();
    const config = JSON.parse(await boundedFile(env.BAIRUI_ADMIN_MONITORING_CONFIG_FILE, 8192));
    const keys = ['version', 'installation', 'upstreamUrl', 'publicOrigin', 'metricsPort', 'bridgeTokenFile', 'metricsTokenFile'];
    if (!config || Array.isArray(config) || Object.keys(config).length !== keys.length || Object.keys(config).some(key => !keys.includes(key))
      || config.version !== 1 || !/^[a-f0-9]{24}$/.test(config.installation) || config.upstreamUrl !== 'http://127.0.0.1:9493'
      || config.publicOrigin !== 'http://localhost:5173' || config.metricsPort !== 9465) throw new Error();
    const token = (await boundedFile(config.bridgeTokenFile, 65)).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error();
    const metricsToken = (await boundedFile(config.metricsTokenFile, 65)).trim();
    if (!/^[a-f0-9]{64}$/.test(metricsToken)) throw new Error();
    return { ...env, BAIRUI_PROMETHEUS_URL: config.upstreamUrl + '/prometheus', BAIRUI_GRAFANA_UPSTREAM_URL: config.upstreamUrl,
      BAIRUI_GRAFANA_PUBLIC_ORIGIN: config.publicOrigin, BAIRUI_MONITORING_PROXY_TOKEN: token,
      BAIRUI_METRICS_ENABLED: '1', BAIRUI_METRICS_PORT: String(config.metricsPort), BAIRUI_METRICS_TOKEN_FILE: config.metricsTokenFile, BAIRUI_HOST_METRICS_ENABLED: '1' };
  } catch { throw new Error('invalid_business_monitoring_configuration'); }
}
