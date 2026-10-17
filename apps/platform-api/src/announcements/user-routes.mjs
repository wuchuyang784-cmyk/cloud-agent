import { randomUUID } from 'node:crypto';
import { readUserAnnouncements } from './store.mjs';
import { isAnnouncementId } from './validation.mjs';
import { readNotificationCenter, markCenterNotificationRead, markNotificationCenterRead } from './notifications.mjs';

const budgets = new WeakMap();
function takeSlot(store, actor, write) {
  let budget = budgets.get(store);
  if (!budget) { budget = { active: 0, actors: new Map() }; budgets.set(store, budget); }
  const now = Date.now();
  for (const [key, value] of budget.actors) if (value.until <= now) budget.actors.delete(key);
  const key = JSON.stringify([actor, write]);
  if (budget.active >= 16 || (!budget.actors.has(key) && budget.actors.size >= 4096)) return { retry: 1 };
  const window = budget.actors.get(key) ?? { count: 0, until: now + 60000 };
  if (window.count >= (write ? 120 : 240)) return { retry: Math.max(1, Math.ceil((window.until - now) / 1000)) };
  window.count++; budget.actors.set(key, window); budget.active++;
  return { release: () => { budget.active--; } };
}

function bodyOf(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const timer = setTimeout(() => finish(new Error('request_timeout')), 10000);
    const onData = chunk => { bytes += chunk.length; if (bytes > 1024) finish(new Error('payload_too_large')); else chunks.push(chunk); };
    const onEnd = () => { try { finish(null, { empty: bytes === 0, input: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch { finish(new Error('invalid_json')); } };
    const onError = () => finish(new Error('invalid_json'));
    const finish = (error, value) => {
      clearTimeout(timer); request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onError);
      if (error) { request.on('error', () => {}); request.resume(); reject(error); } else resolve(value);
    };
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onError);
  });
}

export async function handleNotificationCenter({ request, response, url, scope, store, env, strictOrigin, sendJson, sendError, requestId }) {
  const fail = (status, code) => sendError(response, status, code, code, requestId);
  response.setHeader('cache-control', 'no-store');
  const announcement = url.pathname.match(/^\/api\/user\/announcements(?:\/([^/]+)(\/read)?)?$/);
  const notification = url.pathname.match(/^\/api\/user\/notifications(?:\/([^/]+))?$/);
  if ((!announcement && !notification) || (announcement?.[1] && !isAnnouncementId(announcement[1]))) return fail(404, 'not_found');
  if (notification?.[1] && !/^[a-zA-Z0-9-]{1,128}$/.test(notification[1])) return fail(404, 'not_found');
  const id = announcement?.[1]?.toLowerCase(), all = notification?.[1] === 'read-all';
  const allowed = announcement ? announcement[2] ? 'POST' : 'GET' : all ? 'POST' : notification[1] ? 'PATCH' : 'GET';
  if (request.method !== allowed) { response.setHeader('allow', allowed); return fail(405, 'method_not_allowed'); }
  const write = request.method !== 'GET'; let release;
  try {
    const slot = takeSlot(store, scope.userId, write);
    if (!slot.release) { response.setHeader('retry-after', String(slot.retry)); return fail(429, 'notification_rate_limited'); }
    release = slot.release;
    let result;
    if (!write) {
      const keys = id ? ['history'] : announcement ? ['read', 'history', 'after', 'limit'] : ['source', 'read', 'history', 'after', 'limit'];
      for (const key of url.searchParams.keys()) if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1) return fail(422, 'invalid_notification_query');
      const query = Object.fromEntries(url.searchParams);
      if ('limit' in query) { if (!/^(?:[1-9][0-9]?|100)$/.test(query.limit)) return fail(422, 'invalid_notification_query'); query.limit = Number(query.limit); }
      if ('history' in query) { if (!['true', 'false'].includes(query.history)) return fail(422, 'invalid_notification_query'); query.history = query.history === 'true'; }
      if (id) {
        result = await readUserAnnouncements(store, scope, { id, ...query });
        if (!result.error) {
          const count = await readNotificationCenter(store, scope, { limit: 1 });
          if (count.error) result = count;
          else { result.unreadCount = count.unreadCount; if (result.announcement.status === 'expired') result.announcement.pinned = false; }
        }
      } else {
        result = await readNotificationCenter(store, scope, { ...query, ...(announcement ? { source: 'announcement' } : {}) });
        if (announcement && !result.error) { const { notifications, ...rest } = result; result = { items: notifications, ...rest }; }
      }
    } else {
      if (url.search) return fail(422, 'invalid_notification_query');
      if (strictOrigin) {
        let origin; try { origin = new URL(env.BETTER_AUTH_URL).origin; } catch { return fail(403, 'origin_rejected'); }
        if (request.headers.origin !== origin) return fail(403, 'origin_rejected');
      }
      const contentType = request.headers['content-type'];
      if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) return fail(415, 'json_required');
      if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') return fail(415, 'encoding_rejected');
      let parsed;
      try { parsed = await bodyOf(request); }
      catch (error) { return fail(error.message === 'payload_too_large' ? 413 : error.message === 'request_timeout' ? 408 : 400, error.message); }
      if (!parsed.empty && !contentType) return fail(415, 'json_required');
      const { input, empty } = parsed;
      if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(422, 'invalid_notification_input');
      if (all) {
        if ((!empty && (!isAnnouncementId(input.requestId) || Object.keys(input).length !== 1))) return fail(422, 'invalid_notification_input');
        result = await markNotificationCenterRead(store, scope, empty ? randomUUID() : input.requestId);
      } else {
        if (Object.keys(input).some(k => k !== 'read' || announcement) || ('read' in input && input.read !== true)) return fail(422, 'invalid_notification_input');
        result = await markCenterNotificationRead(store, scope, announcement ? 'announcement:' + id : notification[1]);
        if (announcement && !result.error) result = { ok: true, id, isRead: true, unreadCount: result.unreadCount };
      }
    }
    if (result.error) return fail(result.error === 'not_found' ? 404 : ['account_banned', 'account_read_only'].includes(result.error) ? 403 : 422, result.error);
    return sendJson(response, 200, result);
  } catch { return fail(503, 'announcements_unavailable'); }
  finally { release?.(); }
}
