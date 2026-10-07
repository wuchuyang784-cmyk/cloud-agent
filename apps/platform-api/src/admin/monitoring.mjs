const queries = Object.freeze({
  apiReplicas: 'sum(up{job="bairui-api"}) or vector(0)',
  databaseReady: 'min(bairui_database_ready{job="bairui-api"})',
  requestRate: 'sum(rate(bairui_http_requests_total{job="bairui-api",route!~"/(livez|readyz|healthz)"}[5m]))',
  latencyP95: 'histogram_quantile(0.95, sum by (le) (rate(bairui_http_request_duration_seconds_bucket{job="bairui-api",route!~"/(livez|readyz|healthz)"}[5m])))',
  errorRate: 'sum(rate(bairui_http_requests_total{job="bairui-api",status=~"5..",route!~"/(livez|readyz|healthz)"}[5m])) / clamp_min(sum(rate(bairui_http_requests_total{job="bairui-api",route!~"/(livez|readyz|healthz)"}[5m])), 0.001)',
  firingAlerts: 'count(ALERTS{alertstate="firing"}) or vector(0)',
});
const freshnessQueries = Object.freeze({
  apiReplicas: 'min(timestamp(up{job="bairui-api"})) or vector(time())',
  databaseReady: 'min(timestamp(bairui_database_ready{job="bairui-api"}))',
  requestRate: 'min(timestamp(bairui_http_requests_total{job="bairui-api",route!~"/(livez|readyz|healthz)"}))',
  latencyP95: 'min(timestamp(bairui_http_request_duration_seconds_bucket{job="bairui-api",route!~"/(livez|readyz|healthz)"}))',
  errorRate: 'min(timestamp(bairui_http_requests_total{job="bairui-api",route!~"/(livez|readyz|healthz)"}))',
  firingAlerts: 'min(timestamp(up{job="prometheus"}))',
});

class MonitoringUnavailable extends Error {}

async function boundedJson(response, maxBytes) {
  if (!response.ok || !response.body) throw new MonitoringUnavailable();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new MonitoringUnavailable(); }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new MonitoringUnavailable(); }
}
export function createAdminMonitoring({ baseUrl = '', fetchImpl = fetch, timeoutMs = 3000, maxBytes = 262144, maxConcurrent = 4, maxQueue = 32 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024
    || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16
    || !Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 256) throw new Error('invalid_monitoring_configuration');
  let origin = null;
  try {
    const parsed = new URL(baseUrl);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    origin = parsed.href.replace(/\/$/, '');
  } catch { origin = null; }
  let active = 0;
  const waiters = [];
  const acquire = async deadline => {
    if (active >= maxConcurrent) {
      if (waiters.length >= maxQueue) throw new MonitoringUnavailable();
      await new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new MonitoringUnavailable());
        }, Math.max(1, deadline - Date.now()));
        waiters.push(waiter);
      });
    }
    active++;
    return () => {
      active--;
      const waiter = waiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(); }
    };
  };
  const request = async (path, params = {}) => {
    if (!origin) throw new MonitoringUnavailable();
    const deadline = Date.now() + timeoutMs;
    const release = await acquire(deadline);
    try {
      const url = new URL(origin + path);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      const value = await boundedJson(response, maxBytes);
      if (value?.status !== 'success' || !value.data) throw new MonitoringUnavailable();
      return value.data;
    } catch (error) {
      if (error instanceof MonitoringUnavailable) throw error;
      throw new MonitoringUnavailable();
    } finally { release(); }
  };
  const resultRow = async expression => {
    const data = await request('/api/v1/query', { query: expression });
    const row = Array.isArray(data.result) ? data.result[0] : null;
    if (!row || !Array.isArray(row.value) || row.value.length !== 2) return null;
    const numeric = Number(row.value[1]);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const scalar = async (expression, freshness) => {
    const [value, sampledSeconds] = await Promise.all([resultRow(expression), resultRow(freshness)]);
    if (value === null || sampledSeconds === null) return { status: 'empty', value: null, sampledAt: null };
    const sampledAt = new Date(sampledSeconds * 1000);
    if (!Number.isFinite(sampledAt.getTime())) return { status: 'empty', value: null, sampledAt: null };
    return { status: Date.now() - sampledAt.getTime() > 60_000 ? 'stale' : 'fresh', value, sampledAt: sampledAt.toISOString() };
  };
  return {
    enabled: Boolean(origin),
    async overview() {
      const entries = await Promise.all(Object.entries(queries).map(async ([key, expression]) => [key, await scalar(expression, freshnessQueries[key])]));
      const metrics = Object.fromEntries(entries);
      const dates = entries.map(([, item]) => item.sampledAt).filter(Boolean).sort();
      const states = entries.map(([, item]) => item.status);
      return { status: states.every(x => x === 'empty') ? 'empty' : states.includes('stale') ? 'stale' : 'fresh', sampledAt: dates.at(-1) ?? null, metrics };
    },
    async alerts({ severity = '', state = '' } = {}) {
      const data = await request('/api/v1/alerts');
      const alerts = Array.isArray(data.alerts) ? data.alerts : [];
      return { items: alerts.filter(item => (!severity || item.labels?.severity === severity) && (!state || item.state === state)).slice(0, 100).map(item => ({
        name: String(item.labels?.alertname ?? ''), severity: String(item.labels?.severity ?? 'info'), state: String(item.state ?? ''),
        activeAt: item.activeAt ? String(item.activeAt) : null, instance: item.labels?.instance ? String(item.labels.instance) : null,
      })) };
    },
  };
}
