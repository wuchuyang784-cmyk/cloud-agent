import { readAdmin } from './store.mjs';

const statuses = new Set(['uninitialized', 'provisioning', 'starting', 'ready', 'degraded', 'offline', 'failed', 'stopped']);
const resources = new Set(['me', 'users', 'agents']);

export async function handleAdmin({ request, response, url, principal, store, enabled, sendJson, sendError, requestId }) {
  const fail = (status, code) => sendError(response, status, code, code, requestId);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('vary', 'Cookie');
  if (!enabled) return fail(404, 'not_found');
  if (!principal) return fail(401, 'unauthenticated');
  try {
    // Authorization never comes from an organization role or a browser-supplied actor.
    const access = await readAdmin(store, principal.userId, 'me');
    if (!access) return fail(403, 'platform_role_required');
    const resource = url.pathname.slice('/api/admin/'.length);
    if (!resources.has(resource)) return fail(404, 'not_found');
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      return fail(405, 'method_not_allowed');
    }
    const allowed = resource === 'me' ? [] : ['q', 'after', 'limit', ...(resource === 'agents' ? ['ownerUserId', 'status'] : [])];
    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) return fail(422, 'invalid_admin_query');
    }
    const query = Object.fromEntries(url.searchParams);
    if (Object.values(query).some(value => value.length > 200 || /[\x00-\x1f\x7f]/.test(value))
      || (query.limit !== undefined && (!/^[1-9][0-9]?$|^100$/.test(query.limit)))
      || (query.status && !statuses.has(query.status))) return fail(422, 'invalid_admin_query');
    query.limit = Number(query.limit ?? 25);
    const result = resource === 'me' ? access : await readAdmin(store, principal.userId, resource, query);
    if (!result) return fail(403, 'platform_role_required');
    return sendJson(response, 200, result);
  } catch {
    // No SQL, identity, search terms or connection details in API errors.
    return fail(503, 'admin_unavailable');
  }
}
