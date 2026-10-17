import { createHash, randomUUID } from 'node:crypto';

const readers = new Set(['platform_admin', 'platform_operator', 'platform_viewer']);
const account = (store, actor) => store.accountGovernance?.get(actor) ?? { status: 'active', version: 0 };
const roleAllowed = (store, actor, write = false) => store.users.has(actor) && account(store, actor).status === 'active'
  && !store.platformRoles?.get(actor)?.revokedAt && readers.has(store.platformRoles?.get(actor)?.role)
  && (!write || store.platformRoles.get(actor).role === 'platform_admin');
const effective = (item, at) => item.status === 'published' && item.expiresAt !== null && Date.parse(item.expiresAt) <= at ? 'expired' : item.status;
const page = (rows, limit) => ({ items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null });
// Titles cannot contain LF, so title + LF + body is unambiguous and matches PostgreSQL byte-for-byte.
const hash = item => createHash('sha256').update(item.title + '\n' + item.body).digest('hex');
const canonical = value => JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]));
const receiptKey = (scope, id) => JSON.stringify([scope.organizationId, scope.userId, id]);
const clock = store => (store.announcementNow ?? Date.now)();

function init(store) {
  store.announcements ??= new Map();
  store.announcementRequests ??= new Map();
  store.announcementAudit ??= [];
  store.announcementReceipts ??= new Map();
}

// Share the existing memory governance decision queue; no await between validation and commit.
async function serial(store, operation) {
  const previous = store.governanceQueue ?? Promise.resolve();
  let unlock;
  store.governanceQueue = new Promise(resolve => { unlock = resolve; });
  await previous;
  try { init(store); return structuredClone(operation()); } finally { unlock(); }
}

export function changeMemory(store, actor, input, now = store.announcementNow ?? Date.now) {
  return serial(store, () => {
    if (!roleAllowed(store, actor, true)) return { error: 'platform_role_required' };
    const key = JSON.stringify([actor, input.requestId]), fingerprint = canonical(input);
    const replay = store.announcementRequests.get(key);
    if (replay) return replay.fingerprint === fingerprint ? { ...replay.result, replayed: true } : { error: 'idempotency_conflict' };
    const at = now(), timestamp = new Date(at).toISOString();
    const before = input.action === 'create' ? null : store.announcements.get(input.id);
    if (input.action !== 'create' && !before) return { error: 'not_found' };
    if (before && before.version !== input.expectedVersion) return { error: 'version_conflict' };
    const item = before ? { ...before } : { id: randomUUID(), status: 'draft', version: 0, severity: 'normal', pinned: false,
      createdBy: actor, createdAt: timestamp, publishedAt: null, scheduledAt: null, scheduledBy: null,
      scheduleGovernanceVersion: null, scheduleRoleRevision: null, expiresAt: null, expiryDays: 30, withdrawnAt: null, withdrawnBy: null, withdrawalReason: null,
      publishBlocked: false, lastPublishError: null, publishAttempts: 0, nextPublishAttemptAt: null };
    const state = before && effective(before, at);
    let action;
    if (['create', 'edit'].includes(input.action)) {
      if (before && state !== 'draft') return { error: 'invalid_announcement_state' };
      for (const field of ['title', 'body', 'severity', 'pinned']) if (field in input) item[field] = input[field];
      if ('expiresAt' in input) { item.expiresAt = input.expiresAt; item.expiryDays = null; }
      if ('expiryDays' in input) { item.expiryDays = 30; item.expiresAt = null; }
      if (item.expiresAt && Date.parse(item.expiresAt) <= at) return { error: 'invalid_announcement_time' };
      action = before ? 'draft_updated' : 'created';
    } else if (['publish', 'schedule'].includes(input.action)) {
      if (state !== 'draft') return { error: 'invalid_announcement_state' };
      const start = input.action === 'schedule' ? Date.parse(input.scheduledAt) : at;
      if ((input.action === 'schedule' && start <= at) || (item.expiresAt && Date.parse(item.expiresAt) <= start)) return { error: 'invalid_announcement_time' };
      if (item.expiryDays !== null) item.expiresAt = new Date(start + item.expiryDays * 86400000).toISOString();
      if (input.action === 'schedule') Object.assign(item, { status: 'scheduled', scheduledAt: input.scheduledAt, scheduledBy: actor,
        scheduleGovernanceVersion: account(store, actor).version, scheduleRoleRevision: store.platformRoles.get(actor).revision ?? 0 });
      else Object.assign(item, { status: 'published', publishedAt: timestamp });
      action = input.action === 'publish' ? 'published' : 'schedule_set';
    } else if (input.action === 'cancel') {
      if (state !== 'scheduled') return { error: 'invalid_announcement_state' };
      Object.assign(item, { status: 'draft', scheduledAt: null, scheduledBy: null, scheduleGovernanceVersion: null, scheduleRoleRevision: null,
        publishBlocked: false, lastPublishError: null, publishAttempts: 0, nextPublishAttemptAt: null });
      if (item.expiryDays !== null) item.expiresAt = null;
      action = 'schedule_cancelled';
    } else {
      if (state !== 'published') return { error: 'invalid_announcement_state' };
      Object.assign(item, { status: 'withdrawn', withdrawnAt: timestamp, withdrawnBy: actor, withdrawalReason: input.reason });
      action = 'withdrawn';
    }
    item.version++;
    Object.assign(item, { updatedAt: timestamp, updatedBy: actor });
    const result = { announcement: item, requestId: input.requestId, replayed: false };
    const audit = { id: String(store.announcementAudit.length + 1), announcementId: item.id, actorUserId: actor, executorType: 'admin', action,
      requestId: input.requestId, previousVersion: before?.version ?? 0, version: item.version, contentHash: hash(item),
      changedFields: Object.keys(input).filter(key => !['requestId', 'id', 'expectedVersion', 'action'].includes(key)).sort(),
      scheduledAt: item.scheduledAt, publishedAt: item.publishedAt, reason: input.reason ?? null, occurredAt: timestamp };
    store.announcements.set(item.id, item);
    store.announcementAudit.push(audit);
    store.announcementRequests.set(key, { fingerprint, result: structuredClone(result) });
    return result;
  });
}

export function readMemory(store, actor, query) {
  init(store);
  if (!roleAllowed(store, actor)) return { error: 'platform_role_required' };
  if (query.id) {
    const item = store.announcements.get(query.id);
    if (!item) return { error: 'not_found' };
    if (!query.audit) return structuredClone({ announcement: { ...item, status: effective(item, clock(store)) } });
    return structuredClone(page(store.announcementAudit.filter(row => row.announcementId === query.id && (!query.after || BigInt(row.id) < BigInt(query.after))).toReversed(), query.limit));
  }
  return structuredClone(page([...store.announcements.values()].map(item => ({ ...item, status: effective(item, clock(store)) }))
    .filter(item => (!query.after || item.id > query.after) && (!query.status || item.status === query.status)
      && (!query.q || item.title.toLowerCase().includes(query.q.toLowerCase()))).sort((a, b) => a.id < b.id ? -1 : 1), query.limit));
}

function scopeError(store, scope, write = false) {
  if (!scope || !store.users.has(scope.userId) || !store.memberships.has(scope.organizationId + ':' + scope.userId)
    || store.organizations.get(scope.organizationId)?.kind !== 'personal') return { error: 'not_found' };
  const state = account(store, scope.userId).status;
  return state === 'banned' ? { error: 'account_banned' } : write && state !== 'active' ? { error: 'account_read_only' } : null;
}

export function readUserMemory(store, scope, query) {
  init(store);
  const error = scopeError(store, scope);
  if (error) return error;
  const rows = [...store.announcements.values()].filter(item => ['published', 'expired'].includes(item.status) && item.publishedAt && Date.parse(item.publishedAt) <= clock(store))
    .map(item => ({ id: item.id, title: item.title, body: item.body, severity: item.severity, pinned: item.pinned,
      status: effective(item, clock(store)), publishedAt: item.publishedAt, expiresAt: item.expiresAt,
      isRead: store.announcementReceipts.has(receiptKey(scope, item.id)) }));
  const unreadCount = rows.filter(item => item.status === 'published' && !item.isRead).length;
  const visible = rows.filter(item => query.history || item.status === 'published');
  if (query.id) return structuredClone(visible.find(item => item.id === query.id) ? { announcement: visible.find(item => item.id === query.id), unreadCount } : { error: 'not_found' });
  return structuredClone({ ...page(visible.filter(item => !query.after || item.id > query.after).sort((a, b) => a.id < b.id ? -1 : 1), query.limit), unreadCount });
}

export function markMemory(store, scope, id) {
  return serial(store, () => {
    const error = scopeError(store, scope, true);
    if (error) return error;
    const item = store.announcements.get(id);
    if (!item || effective(item, clock(store)) !== 'published' || Date.parse(item.publishedAt) > clock(store)) return { error: 'not_found' };
    const key = receiptKey(scope, id);
    if (!store.announcementReceipts.has(key)) store.announcementReceipts.set(key, new Date(clock(store)).toISOString());
    return { id, isRead: true, unreadCount: readUserMemory(store, scope, { limit: 1 }).unreadCount };
  });
}
