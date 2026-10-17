import { isAnnouncementId } from './validation.mjs';
import { announcementQuery } from './postgres.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => new Date(value).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
const receiptKey = (scope, id) => JSON.stringify([scope.organizationId, scope.userId, id]);
const compare = (a, b) => Number(b.pinned) - Number(a.pinned) || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)
  || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || (a.referenceId < b.referenceId ? -1 : a.referenceId > b.referenceId ? 1 : 0);
const clock = store => (store.announcementNow ?? Date.now)();

export function normalizeNotificationQuery(input = {}) {
  if (!object(input) || Object.keys(input).some(k => !['source', 'read', 'history', 'after', 'limit'].includes(k))) return null;
  const q = { source: 'all', read: 'all', history: false, limit: 25, ...input };
  if (!['all', 'announcement', 'notification'].includes(q.source) || !['all', 'unread', 'read'].includes(q.read)
    || typeof q.history !== 'boolean' || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 100) return null;
  if ('after' in input) {
    if (typeof q.after !== 'string' || q.after.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(q.after)) return null;
    try {
      const c = JSON.parse(Buffer.from(q.after, 'base64url').toString('utf8'));
      if (!Array.isArray(c) || c.length !== 7 || c[0] !== q.source || c[1] !== q.read || c[2] !== q.history
        || typeof c[3] !== 'boolean' || typeof c[4] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c[4]) || !Number.isFinite(Date.parse(c[4]))
        || c[4].startsWith('0000') || new Date(c[4]).toISOString().slice(0, 19) !== c[4].slice(0, 19)
        || !['announcement', 'notification'].includes(c[5]) || typeof c[6] !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(c[6])) return null;
      q.cursor = { pinned: c[3], createdAt: c[4], source: c[5], referenceId: c[6] };
    } catch { return null; }
    delete q.after;
  }
  return q;
}

function scopeError(store, scope, write = false) {
  if (!scope || !store.users.has(scope.userId) || !store.memberships.has(scope.organizationId + ':' + scope.userId)
    || store.organizations.get(scope.organizationId)?.kind !== 'personal') return { error: 'not_found' };
  const status = store.accountGovernance?.get(scope.userId)?.status ?? 'active';
  return status === 'banned' ? { error: 'account_banned' } : write && status !== 'active' ? { error: 'account_read_only' } : null;
}

function memoryRows(store, scope) {
  const at = clock(store), receipts = store.announcementReceipts ?? new Map();
  const rows = [...(store.announcements?.values() ?? [])].filter(a => ['published', 'expired'].includes(a.status) && a.publishedAt && Date.parse(a.publishedAt) <= at)
    .map(a => {
      const expired = a.status === 'expired' || (a.expiresAt !== null && Date.parse(a.expiresAt) <= at);
      const readAt = receipts.get(receiptKey(scope, a.id)) ?? null;
      return { id: 'announcement:' + a.id, source: 'announcement', referenceId: a.id, type: 'announcement', title: a.title,
        body: [...a.body].slice(0, 240).join(''), isRead: readAt !== null, readAt, createdAt: timestamp(a.publishedAt),
        pinned: !expired && a.pinned, severity: a.severity, status: expired ? 'expired' : 'published', expiresAt: a.expiresAt };
    });
  for (const n of store.notifications.values()) if (n.userId === scope.userId && n.organizationId === scope.organizationId) rows.push({
    id: n.id, source: 'notification', referenceId: n.id, type: n.type, title: n.title, body: n.body, isRead: n.isRead,
    readAt: n.readAt, createdAt: timestamp(n.createdAt), pinned: false, severity: 'normal', status: 'published', expiresAt: null,
  });
  return rows;
}

export async function readNotificationCenter(store, scope, input = {}) {
  const q = normalizeNotificationQuery(input);
  if (!q) return { error: 'invalid_notification_query' };
  let result;
  if (store.pool) result = await announcementQuery(store, 'centerRead', [scope?.userId ?? null, scope?.organizationId ?? null, q]);
  else {
    const error = scopeError(store, scope); if (error) return error;
    const all = memoryRows(store, scope);
    const rows = all.filter(a => (q.history || a.status !== 'expired') && (q.source === 'all' || a.source === q.source)
      && (q.read === 'all' || (a.isRead === (q.read === 'read') && (q.read !== 'unread' || a.status === 'published')))
      && (!q.cursor || compare(a, q.cursor) > 0)).sort(compare);
    result = { notifications: structuredClone(rows.slice(0, q.limit)), hasMore: rows.length > q.limit,
      unreadCount: all.filter(a => a.status === 'published' && !a.isRead).length };
  }
  if (result.error) return result;
  const last = result.notifications.at(-1);
  return { notifications: result.notifications, unreadCount: result.unreadCount,
    nextCursor: result.hasMore && last ? Buffer.from(JSON.stringify([q.source, q.read, q.history, last.pinned, last.createdAt, last.source, last.referenceId])).toString('base64url') : null };
}

async function serial(store, operation) {
  const previous = store.governanceQueue ?? Promise.resolve(); let unlock;
  store.governanceQueue = new Promise(resolve => { unlock = resolve; }); await previous;
  try { return structuredClone(operation()); } finally { unlock(); }
}

export async function markCenterNotificationRead(store, scope, id) {
  const announcementId = typeof id === 'string' && id.startsWith('announcement:') ? id.slice(13) : null;
  if (typeof id !== 'string' || (announcementId !== null ? !isAnnouncementId(announcementId) : !/^[a-zA-Z0-9-]{1,128}$/.test(id))) return { error: 'not_found' };
  if (store.pool) return announcementQuery(store, 'centerMark', [scope?.userId ?? null, scope?.organizationId ?? null, id]);
  return serial(store, () => {
    const error = scopeError(store, scope, true); if (error) return error;
    const row = memoryRows(store, scope).find(a => a.id === id && a.status === 'published');
    if (!row) return { error: 'not_found' };
    const updated = row.isRead ? 0 : 1;
    if (announcementId) { store.announcementReceipts ??= new Map(); if (updated) store.announcementReceipts.set(receiptKey(scope, announcementId), new Date(clock(store)).toISOString()); }
    else if (updated) Object.assign(store.notifications.get(id), { isRead: true, readAt: new Date(clock(store)).toISOString() });
    return { ok: true, updated, unreadCount: memoryRows(store, scope).filter(a => a.status === 'published' && !a.isRead).length };
  });
}

export async function markNotificationCenterRead(store, scope, requestId) {
  if (!isAnnouncementId(requestId)) return { error: 'invalid_notification_input' };
  if (store.pool) return announcementQuery(store, 'centerAll', [scope?.userId ?? null, scope?.organizationId ?? null, requestId.toLowerCase()]);
  return serial(store, () => {
    const error = scopeError(store, scope, true); if (error) return error;
    store.notificationCenterRequests ??= new Map(); store.announcementReceipts ??= new Map();
    const key = receiptKey(scope, requestId.toLowerCase()), replay = store.notificationCenterRequests.get(key);
    if (replay) return { ...replay, replayed: true, unreadCount: memoryRows(store, scope).filter(a => a.status === 'published' && !a.isRead).length };
    const rows = memoryRows(store, scope).filter(a => a.status === 'published' && !a.isRead), readAt = new Date(clock(store)).toISOString();
    for (const row of rows) {
      if (row.source === 'announcement') store.announcementReceipts.set(receiptKey(scope, row.referenceId), readAt);
      else Object.assign(store.notifications.get(row.id), { isRead: true, readAt });
    }
    const result = { ok: true, updated: rows.length, unreadCount: 0, replayed: false };
    store.notificationCenterRequests.set(key, structuredClone(result)); return result;
  });
}
