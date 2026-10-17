import { changeAnnouncement, readAnnouncements } from './store.mjs';
import { isAnnouncementId, normalizeCommand, normalizeQuery } from './validation.mjs';

const budgets = new WeakMap();
const invalid = code => ({ error: code });

// Per-store/process abuse protection, not a distributed quota. The DB remains the authorization boundary.
function takeWriteSlot(store, actor) {
  let budget = budgets.get(store);
  if (!budget) { budget = { active: 0, actors: new Map() }; budgets.set(store, budget); }
  const now = Date.now();
  for (const [key, value] of budget.actors) if (value.until <= now) budget.actors.delete(key);
  if (budget.active >= 8 || (!budget.actors.has(actor) && budget.actors.size >= 4096)) return { retry: 1 };
  const window = budget.actors.get(actor) ?? { count: 0, until: now + 60000 };
  if (window.count >= 30) return { retry: Math.max(1, Math.ceil((window.until - now) / 1000)) };
  window.count++; budget.actors.set(actor, window); budget.active++;
  return { release: () => { budget.active--; } };
}

// Buffer UTF-8 bytes before decoding. A total deadline also bounds slow/incomplete uploads.
function bodyOf(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => finish(new Error('request_timeout')), 15000);
    const onData = chunk => { bytes += chunk.length; if (bytes > 128 * 1024) finish(new Error('payload_too_large')); else chunks.push(chunk); };
    const onEnd = () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { finish(new Error('invalid_json')); } };
    const onError = () => finish(new Error('invalid_json'));
    const finish = (error, value) => {
      clearTimeout(timer); request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onError);
      if (error) { request.on('error', () => {}); request.resume(); reject(error); } else resolve(value);
    };
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onError);
  });
}

export async function handleAnnouncementAdmin({ request, response, url, actor, access, store, env, sendJson, fail }) {
  const match = url.pathname.match(/^\/api\/admin\/announcements(?:\/([^/]+)(?:\/(publish|cancel-schedule|withdraw|audit))?)?$/);
  if (!match || (match[1] && !isAnnouncementId(match[1]))) return fail(404, 'not_found');
  const id = match[1]?.toLowerCase(), operation = match[2];
  const allowed = operation === 'audit' ? ['GET'] : operation ? ['POST'] : id ? ['GET', 'PATCH'] : ['GET', 'POST'];
  if (!allowed.includes(request.method)) { response.setHeader('allow', allowed.join(', ')); return fail(405, 'method_not_allowed'); }
  const write = request.method !== 'GET';
  if (!access.permissions?.includes(write ? 'announcements:manage' : operation === 'audit' ? 'announcement-audit:read' : 'announcements:read')
    || (write && access.role !== 'platform_admin')) return fail(403, 'platform_role_required');
  let release;
  try {
    let result;
    if (!write) {
      const keys = operation === 'audit' ? ['after', 'limit'] : id ? [] : ['after', 'limit', 'status', 'q'];
      for (const key of url.searchParams.keys()) if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1) return fail(422, 'invalid_announcement_query');
      const query = Object.fromEntries(url.searchParams);
      if ('limit' in query && !/^(?:[1-9][0-9]?|100)$/.test(query.limit)) return fail(422, 'invalid_announcement_query');
      if ('limit' in query) query.limit = Number(query.limit);
      const normalized = normalizeQuery({ ...query, ...(id ? { id } : {}), ...(operation === 'audit' ? { audit: true } : {}) });
      if (!normalized) return fail(422, 'invalid_announcement_query');
      result = await readAnnouncements(store, actor, normalized);
      if (!id && result.items) result = { ...result, items: result.items.map(({ body, ...summary }) => summary) };
    } else {
      if (url.search) return fail(422, 'invalid_announcement_query');
      let origin;
      try { origin = new URL(env.BETTER_AUTH_URL).origin; } catch { return fail(403, 'origin_rejected'); }
      if (request.headers.origin !== origin) return fail(403, 'origin_rejected');
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return fail(415, 'json_required');
      if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') return fail(415, 'encoding_rejected');
      const slot = takeWriteSlot(store, actor);
      if (!slot.release) { response.setHeader('retry-after', String(slot.retry)); return fail(429, 'announcement_rate_limited'); }
      release = slot.release;
      let input;
      try { input = await bodyOf(request); }
      catch (error) { return fail(error.message === 'payload_too_large' ? 413 : error.message === 'request_timeout' ? 408 : 400, error.message); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || ['id', 'action', 'actor', 'actorUserId'].some(key => key in input)) result = invalid('invalid_announcement_input');
      else {
        let action = operation === 'cancel-schedule' ? 'cancel' : operation || (id ? 'edit' : 'create');
        if (operation === 'publish' && 'mode' in input) {
          if (!['immediate', 'schedule'].includes(input.mode) || (input.mode === 'immediate' && 'scheduledAt' in input)) return fail(422, 'invalid_announcement_input');
          action = input.mode === 'schedule' ? 'schedule' : 'publish';
          input = { ...input }; delete input.mode;
        }
        const command = { ...input, action, ...(id ? { id } : {}) };
        result = normalizeCommand(command) ? await changeAnnouncement(store, actor, command) : invalid('invalid_announcement_input');
      }
    }
    if (result.error) {
      const code = result.error;
      return fail(code === 'platform_role_required' ? 403 : code === 'not_found' ? 404 : ['invalid_announcement_input', 'invalid_announcement_query', 'invalid_announcement_time'].includes(code) ? 422 : 409, code);
    }
    if (write && !id) response.setHeader('location', '/api/admin/announcements/' + result.announcement.id);
    return sendJson(response, write && !id && !result.replayed ? 201 : 200, result);
  } catch { return fail(503, 'announcements_unavailable'); }
  finally { release?.(); }
}
