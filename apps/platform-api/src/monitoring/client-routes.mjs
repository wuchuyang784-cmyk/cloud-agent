import { readClientMonitoring } from './client-store.mjs';
import { safeLog } from '../observability/safe-log.mjs';

const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;

export async function handleClientMonitoring({ request, response, url, scope, store, sendJson, sendError, requestId }) {
  const fail = (status, code, message) => sendError(response, status, code, message, requestId);
  const match = url.pathname.match(/^\/api\/user\/monitoring\/agents(?:\/([a-zA-Z0-9_-]{1,128}))?$/);
  if (!match) return fail(404, 'not_found', 'Not found');
  if (request.method !== 'GET') { response.setHeader('allow', 'GET'); return fail(405, 'method_not_allowed', 'Read only'); }
  const params = url.searchParams;
  const allowed = new Set(match[1] ? ['range'] : ['limit', 'after', 'q']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) return fail(422, 'validation_error', 'Unsupported monitoring query');
  }
  const query = match[1] ? { agentId: match[1], range: params.get('range') ?? 'today' }
    : { limit: Number(params.get('limit') ?? 20), after: params.get('after') ?? undefined, q: params.get('q')?.trim() ?? '' };
  if (match[1] ? !['today', '7d', '30d'].includes(query.range)
    : (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(params.get('limit') ?? '20')
      || (query.after !== undefined && !idPattern.test(query.after)) || query.q.length > 100 || /[\x00-\x1f\x7f]/.test(query.q))) {
    return fail(422, 'validation_error', 'Invalid monitoring query');
  }
  try {
    const result = await readClientMonitoring(store, scope, query);
    return result ? sendJson(response, 200, result) : fail(404, 'not_found', 'Not found');
  } catch {
    safeLog('client_monitoring_unavailable');
    return fail(503, 'monitoring_unavailable', 'Monitoring unavailable');
  }
}
