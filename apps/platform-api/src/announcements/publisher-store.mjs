import { createHash } from 'node:crypto';
import { rollbackForRelease } from '../postgres-transaction.mjs';

const fields = ['processed', 'published', 'expired', 'blocked', 'failed', 'pending', 'maxDelaySeconds', 'blockedTotal'];
const empty = () => Object.fromEntries(fields.map(key => [key, 0]));
const governance = (store, id) => store.accountGovernance?.get(id) ?? { status: 'active', version: 0 };
const due = (a, at) => (a.status === 'published' || a.status === 'scheduled') &&
  (a.expiresAt !== null && Date.parse(a.expiresAt) <= at || a.status === 'scheduled' &&
    (!a.publishBlocked || a.lastPublishError === 'publisher_item_failed') && Date.parse(a.scheduledAt) <= at);

function status(store, at) {
  const rows = [...(store.announcements?.values() ?? [])];
  const pending = rows.filter(a => a.status === 'scheduled' && !a.publishBlocked && Date.parse(a.scheduledAt) <= at);
  return { pending: pending.length, maxDelaySeconds: pending.reduce((max, a) => Math.max(max, Math.floor((at - Date.parse(a.scheduledAt)) / 1000)), 0),
    blockedTotal: rows.filter(a => a.status === 'scheduled' && a.publishBlocked).length };
}

async function tickMemory(store, limit, now) {
  const previous = store.governanceQueue ?? Promise.resolve(); let unlock;
  store.governanceQueue = new Promise(resolve => { unlock = resolve; });
  await previous;
  try {
    store.announcements ??= new Map(); store.announcementAudit ??= [];
    const at = now(), timestamp = new Date(at).toISOString(), result = empty();
    const candidates = [...store.announcements.values()].filter(a => due(a, at) && (!a.nextPublishAttemptAt || Date.parse(a.nextPublishAttemptAt) <= at))
      .sort((a, b) => Date.parse(a.scheduledAt ?? a.expiresAt) - Date.parse(b.scheduledAt ?? b.expiresAt) || a.id.localeCompare(b.id)).slice(0, limit);
    for (const before of candidates) {
      result.processed++;
      const a = { ...before }, g = governance(store, a.scheduledBy), role = store.platformRoles?.get(a.scheduledBy);
      const action = a.expiresAt && Date.parse(a.expiresAt) <= at ? 'expired' :
        a.publishBlocked || !store.users.has(a.scheduledBy) || g.status !== 'active' || g.version !== a.scheduleGovernanceVersion ||
          (role?.revision ?? 0) !== a.scheduleRoleRevision || role?.revokedAt || role?.role !== 'platform_admin' ? 'publish_blocked' : 'published';
      a.version++; a.updatedAt = timestamp;
      Object.assign(a, { publishAttempts: Math.min(30, (a.publishAttempts ?? 0) + 1), nextPublishAttemptAt: null, lastPublishError: null });
      if (action === 'publish_blocked') Object.assign(a, { publishBlocked: true, lastPublishError: 'publisher_authorization_changed' });
      else { a.status = action; if (action === 'published') a.publishedAt = timestamp; }
      const event = { id: String(store.announcementAudit.length + 1), announcementId: a.id, actorUserId: a.scheduledBy,
        executorType: 'system', executorId: 'memory-publisher', scheduleGovernanceVersion: a.scheduleGovernanceVersion,
        action, requestId: null, previousVersion: before.version, version: a.version,
        contentHash: createHash('sha256').update(a.title + '\n' + a.body).digest('hex'), changedFields: [action === 'publish_blocked' ? 'publishBlocked' : 'status'],
        scheduledAt: a.scheduledAt, publishedAt: a.publishedAt, reason: action === 'publish_blocked' ? 'publisher_authorization_changed' : null, occurredAt: timestamp };
      try {
        store.announcementAudit.push(event);
        store.announcements.set(a.id, a);
        result[action === 'publish_blocked' ? 'blocked' : action]++;
      } catch {
        const attempts = Math.min(30, (before.publishAttempts ?? 0) + 1);
        store.announcements.set(before.id, { ...before, publishBlocked: before.publishBlocked || action === 'publish_blocked', publishAttempts: attempts, lastPublishError: 'publisher_item_failed',
          nextPublishAttemptAt: new Date(at + Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6))).toISOString() });
        result.failed++;
      }
    }
    return { ...result, ...status(store, at) };
  } finally { unlock(); }
}

/** Machine-only aggregate operation. PostgreSQL always uses its own clock. */
export async function publisherTick(store, { limit = 50, now = store.announcementNow ?? Date.now } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Object.assign(new Error('invalid_publisher_limit'), { code: 'invalid_publisher_limit' });
  if (!store.pool) return tickMemory(store, limit, now);
  let client, releaseError, connectionError;
  const onError = error => { connectionError = error || true; };
  const query = async (sql, parameters) => {
    if (connectionError) throw new Error('announcement_publisher_unavailable');
    const result = await client.query(sql, parameters);
    if (connectionError) throw new Error('announcement_publisher_unavailable');
    return result;
  };
  try {
    client = await store.pool.connect();
    client.on('error', onError);
    await query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await query("SET LOCAL statement_timeout='10s'");
    await query("SET LOCAL lock_timeout='2s'");
    const result = await query('SELECT platform_announcement_publisher_tick($1::integer) AS result', [limit]);
    await query('COMMIT');
    return Object.fromEntries(fields.map(key => [key, Number(result.rows[0].result[key])]));
  } catch {
    if (client) releaseError = await rollbackForRelease(client);
    throw Object.assign(new Error('announcement_publisher_unavailable'), { code: 'announcement_publisher_unavailable' });
  } finally {
    client?.removeListener('error', onError);
    client?.release(connectionError || releaseError);
  }
}
