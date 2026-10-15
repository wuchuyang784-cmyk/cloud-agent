import { grafanaExpressions } from './grafana-dashboard.mjs';
import { monitoringPublicOrigin } from './monitoring-origin.mjs';

export const grafanaPrefix = '/api/admin/grafana/';
export const grafanaDashboardUrl = grafanaPrefix + 'd/bairui-platform/bairui-platform?kiosk';
const expressions = new Set(grafanaExpressions);
const readPaths = new Set(['api/health', 'api/frontend/settings', 'api/user', 'api/user/orgs', 'api/org', 'api/org/preferences', 'api/user/preferences',
  'api/search', 'api/annotations', 'api/dashboards/uid/bairui-platform', 'api/datasources', 'api/datasources/uid/bairui-prometheus',
  'api/plugins/prometheus/settings', 'api/access-control/user/permissions', 'api/live/ws', 'api/folders/bairui-platform-folder',
  'apis/preferences.grafana.app/v1/namespaces/default/preferences/merged',
  'apis/features.grafana.app/v0alpha1/namespaces/default/ofrep/v1/evaluate/flags',
  'apis/dashboard.grafana.app/', 'apis/dashboard.grafana.app/v2beta1/namespaces/default/dashboards/bairui-platform/dto',
  'apis/dashboard.grafana.app/v2/namespaces/default/dashboards/bairui-platform/dto']);

function fixedQuery(body) {
  if (!body || !Array.isArray(body.queries) || body.queries.length < 1 || body.queries.length > 20) throw new Error('invalid_grafana_query');
  const from = Number(body.from), to = Number(body.to);
  if (!/^\d{13}$/.test(String(body.from)) || !/^\d{13}$/.test(String(body.to)) || from > to || to > Date.now() + 60000
    || to - from > 31 * 86400000) throw new Error('invalid_grafana_query');
  return { from: String(from), to: String(to), queries: body.queries.map(q => {
    if (!q || !expressions.has(q.expr) || q.datasource?.uid !== 'bairui-prometheus' || q.datasource?.type !== 'prometheus'
      || !/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(q.refId) || (q.maxDataPoints !== undefined && (!Number.isInteger(q.maxDataPoints) || q.maxDataPoints < 1 || q.maxDataPoints > 5000))
      || (q.intervalMs !== undefined && (!Number.isInteger(q.intervalMs) || q.intervalMs < 1000 || q.intervalMs > 86400000))) throw new Error('invalid_grafana_query');
    return { refId: q.refId, expr: q.expr, datasource: { uid: 'bairui-prometheus', type: 'prometheus' },
      intervalMs: Math.max(q.intervalMs ?? 15000, Math.ceil((to - from) / (q.maxDataPoints ?? 1000))), maxDataPoints: q.maxDataPoints ?? 1000, instant: q.instant === true, range: q.instant === true ? false : q.range !== false,
      legendFormat: typeof q.legendFormat === 'string' && q.legendFormat.length <= 128 ? q.legendFormat : '', format: q.format === 'table' ? 'table' : 'time_series' };
  }) };
}

export function createGrafanaProxy({ baseUrl = '', token = '', publicOrigin = '', authMode = 'bearer', fetchImpl = fetch, timeoutMs = 20000,
  maxConcurrent = 32, maxBytes = 32 * 1024 * 1024 } = {}) {
  let origin = null, browserOrigin = null;
  if (!['bearer', 'session'].includes(authMode)) throw new Error('invalid_grafana_configuration');
  if (baseUrl || token || publicOrigin || authMode === 'session') {
    try {
      const url = new URL(baseUrl), browser = new URL(monitoringPublicOrigin(publicOrigin));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || (authMode === 'session' ? baseUrl !== 'http://bairui-preprod-gateway:9494' || Boolean(token) : !/^[a-f0-9]{64}$/.test(token))) throw new Error();
      origin = url.origin; browserOrigin = browser.origin;
    } catch { throw new Error('invalid_grafana_configuration'); }
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || !Number.isInteger(maxBytes) || maxBytes < 1024
    || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) throw new Error('invalid_grafana_configuration');
  let active = 0;
  return { enabled: Boolean(origin), dashboardUrl: grafanaDashboardUrl,
    async handle({ request, response, url, principal, readJson, fail }) {
      if (!origin) return fail(503, 'grafana_unavailable');
      const path = url.pathname.slice(grafanaPrefix.length);
      // Reject raw escaped/separator paths before URL normalization can disguise them.
      const rawPath = request.url.split('?')[0];
      if (!rawPath.startsWith(grafanaPrefix) || /%|\\|\/\.{1,2}(?:\/|$)/.test(rawPath) || path.includes('//')) return fail(404, 'not_found');
      const writeQuery = path === 'api/ds/query' && request.method === 'POST';
      const featureRead = path === 'apis/features.grafana.app/v0alpha1/namespaces/default/ofrep/v1/evaluate/flags' && request.method === 'POST';
      const discardedTelemetry = path === 'api/frontend-metrics' && request.method === 'POST';
      const jsonPost = writeQuery || featureRead || discardedTelemetry;
      const staticAsset = /^public\/[A-Za-z0-9_./-]+$/.test(path) && !path.includes('..');
      const dashboard = path === 'd/bairui-platform/bairui-platform';
      if (!jsonPost && (!['GET', 'HEAD'].includes(request.method) || (!staticAsset && !dashboard && !readPaths.has(path) && path !== ''))) return fail(404, 'not_found');
      if (path === 'api/live/ws') return fail(404, 'not_found'); // Live disabled, never relay WebSockets.
      if (url.search.length > 2048 || [...url.searchParams].some(([key, value]) => !['orgId', 'kiosk', 'from', 'to', 'refresh', 'timezone', 'theme', 'requestId', 'ds_type',
        'limit', 'type', 'query', 'dashboardUID', 'start', 'end', 'tags', 'page', 'filter', 'accesscontrol', 'isLegacyCall', 'matchAny', '_cache'].includes(key) || value.length > 256)
        || (url.searchParams.has('orgId') && url.searchParams.get('orgId') !== '1')) return fail(422, 'invalid_grafana_query');
      for (const key of ['accesscontrol', 'isLegacyCall']) if (url.searchParams.has(key) && (path !== 'api/folders/bairui-platform-folder'
        || !['true', 'false'].includes(url.searchParams.get(key)))) return fail(422, 'invalid_grafana_query');
      if (url.searchParams.has('_cache') && !staticAsset) return fail(422, 'invalid_grafana_query');
      if (url.searchParams.has('matchAny') && (path !== 'api/annotations'
        || !['true', 'false'].includes(url.searchParams.get('matchAny')))) return fail(422, 'invalid_grafana_query');
      if (request.headers.origin && request.headers.origin !== browserOrigin) return fail(403, 'origin_rejected');
      if (jsonPost) {
        if (request.headers.origin !== browserOrigin) return fail(403, 'origin_rejected');
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return fail(415, 'json_required');
      }
      if (path === '') { response.writeHead(302, { location: grafanaDashboardUrl }); return response.end(); }
      if (active >= maxConcurrent) return fail(503, 'grafana_unavailable');
      active++;
      const controller = new AbortController(); let readingBody = jsonPost;
      const timeout = setTimeout(() => { controller.abort(); if (readingBody) request.destroy(); }, timeoutMs);
      try {
        let body;
        if (jsonPost) {
          try {
            const input = await readJson(request, 65536);
            if (discardedTelemetry) { response.writeHead(204, { 'cache-control': 'no-store' }); return response.end(); }
            // No browser identity attributes or arbitrary feature payload reaches Grafana.
            body = JSON.stringify(featureRead ? { context: {} } : fixedQuery(input));
          }
          catch (error) { if (!response.destroyed) return fail(error.message === 'payload_too_large' ? 413 : 422, 'invalid_grafana_query'); return; }
          finally { readingBody = false; }
        }
        const upstream = await fetchImpl(origin + grafanaPrefix + path + url.search, {
          method: request.method, headers: { ...(authMode === 'session'
            ? (request.headers.cookie ? { cookie: request.headers.cookie } : {})
            : { authorization: 'Bearer ' + token, 'x-bairui-monitor-user': 'bairui:' + principal.userId, 'x-bairui-monitor-role': 'Viewer' }),
            ...(body ? { 'content-type': 'application/json' } : {}), accept: request.headers.accept ?? '*/*' },
          ...(body ? { body } : {}), redirect: 'manual', signal: controller.signal,
        });
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel();
          const target = new URL(upstream.headers.get('location') ?? '', origin);
          if (![origin, browserOrigin].includes(target.origin) || !target.pathname.startsWith(grafanaPrefix)
            || target.pathname === grafanaPrefix + 'login') throw new Error('unsafe_redirect');
          response.writeHead(upstream.status, { location: target.pathname + target.search }); return response.end();
        }
        if (upstream.status >= 500 || upstream.status === 401 || upstream.status === 403) { await upstream.body?.cancel(); throw new Error('upstream_unavailable'); }
        const chunks = []; let size = 0;
        if (upstream.body) {
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > (staticAsset ? maxBytes : Math.min(maxBytes, 2 * 1024 * 1024))) { await reader.cancel(); throw new Error('response_too_large'); }
            chunks.push(value);
          }
        }
        if (response.destroyed) return;
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "frame-ancestors 'self'" });
        response.end(request.method === 'HEAD' ? undefined : Buffer.concat(chunks));
      } catch { if (!response.destroyed) return fail(503, 'grafana_unavailable'); }
      finally { clearTimeout(timeout); controller.abort(); active--; }
    },
  };
}
