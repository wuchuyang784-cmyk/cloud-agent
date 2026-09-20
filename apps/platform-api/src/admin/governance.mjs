import { rollbackForRelease } from '../postgres-transaction.mjs';

const active = () => ({ status: 'active', version: 0, changedAt: null });
const readers = new Set(['platform_viewer', 'platform_operator', 'platform_admin']);
export class GovernanceError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}

async function query(store, sql, params) {
  const c = await store.pool.connect();
  let releaseError;
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout = '3s'");
    const result = await c.query(sql, params);
    await c.query('COMMIT');
    return result.rows[0].result;
  } catch (error) {
    releaseError = await rollbackForRelease(c);
    throw error;
  } finally { c.release(releaseError); }
}

export async function accountAccess(store, userId) {
  try {
    const value = store.pool ? await query(store, 'SELECT platform_account_access($1) AS result', [userId]) : store.accountGovernance?.get(userId) ?? active();
    if (!value || !['active', 'suspended', 'banned'].includes(value.status) || !Number.isSafeInteger(value.version)) throw new Error('invalid_account_state');
    return value;
  } catch { throw new GovernanceError('governance_unavailable'); }
}

export async function sessionAllowed(store, authId) {
  if (store.pool) return query(store, 'SELECT platform_account_session_allowed($1) AS result', [authId]);
  const user = [...store.users.values()].find(u => u.authSubject === 'better-auth:' + authId);
  return !user || (await accountAccess(store, user.id)).status !== 'banned';
}

function memoryAccess(store, actor, write = false) {
  const binding = store.platformRoles?.get(actor);
  return store.users.has(actor) && !binding?.revokedAt && readers.has(binding?.role)
    && (!write || binding.role === 'platform_admin') && (store.accountGovernance?.get(actor)?.status ?? 'active') === 'active';
}

export async function readGovernance(store, actor, target, after = '') {
  if (store.pool) return query(store, 'SELECT platform_governance_read($1,$2,$3) AS result', [actor, target, after || null]);
  if (!memoryAccess(store, actor)) return { error: 'platform_role_required' };
  if (!store.users.has(target)) return { error: 'not_found' };
  const rows = (store.governanceAudit ?? []).filter(row => row.targetUserId === target && (!after || BigInt(row.id) < BigInt(after))).reverse();
  const items = rows.slice(0, 25).map(({ input, ...row }) => row);
  return { account: store.accountGovernance?.get(target) ?? active(), items, nextCursor: rows.length > 25 ? items.at(-1).id : null };
}

export async function changeGovernance(store, actor, target, input) {
  if (store.pool) return query(store, 'SELECT platform_governance_change($1,$2,$3,$4,$5,$6) AS result', [actor, target, input.status, input.expectedVersion, input.reason, input.requestId]);
  const previous = store.governanceQueue ?? Promise.resolve();
  let unlock;
  store.governanceQueue = new Promise(resolve => { unlock = resolve; });
  await previous;
  try {
    if (!memoryAccess(store, actor, true)) return { error: 'platform_role_required' };
    if (!store.users.has(target)) return { error: 'not_found' };
    if (actor === target) return { error: 'self_governance_forbidden' };
    store.accountGovernance ??= new Map();
    store.governanceAudit ??= [];
    const replay = store.governanceAudit.find(row => row.actorUserId === actor && row.requestId === input.requestId);
    if (replay) return replay.targetUserId === target && ['status', 'expectedVersion', 'reason', 'requestId'].every(key => replay.input[key] === input[key])
      ? { account: replay.account, requestId: input.requestId, replayed: true } : { error: 'idempotency_conflict' };
    const before = store.accountGovernance.get(target) ?? active();
    if (before.version !== input.expectedVersion) return { error: 'version_conflict' };
    if (before.status === input.status) return { error: 'state_unchanged' };
    if (input.status !== 'active' && store.platformRoles.get(target)?.role === 'platform_admin'
      && ![...store.platformRoles.keys()].some(id => id !== target && memoryAccess(store, id, true))) return { error: 'last_admin_protected' };
    if (input.status === 'banned') await store.governanceRevokeSessions?.(target);
    const account = { status: input.status, version: before.version + 1, changedAt: new Date().toISOString() };
    store.accountGovernance.set(target, account);
    store.governanceAudit.push({ id: String(store.governanceAudit.length + 1), actorUserId: actor, targetUserId: target,
      previousStatus: before.status, status: input.status, reason: input.reason, requestId: input.requestId,
      occurredAt: account.changedAt, account, input: { ...input } });
    return { account, requestId: input.requestId, replayed: false };
  } finally { unlock(); }
}

export async function handleGovernance({ request, response, url, actor, target, access, store, env, readJson, sendJson, fail }) {
  if (url.search && (request.method !== 'GET' || [...url.searchParams.keys()].some(k => k !== 'after')
    || url.searchParams.getAll('after').length !== 1 || !/^[1-9][0-9]{0,17}$/.test(url.searchParams.get('after') ?? ''))) return fail(422, 'invalid_governance_query');
  let result;
  if (request.method === 'GET') result = await readGovernance(store, actor, target, url.searchParams.get('after') || '');
  else if (request.method === 'POST') {
    if (access.role !== 'platform_admin') return fail(403, 'platform_role_required');
    if (!env.BETTER_AUTH_URL || request.headers.origin !== new URL(env.BETTER_AUTH_URL).origin) return fail(403, 'origin_rejected');
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) return fail(415, 'json_required');
    let input;
    try { input = await readJson(request, 4096); }
    catch (error) { return fail(error.message === 'payload_too_large' ? 413 : 400, error.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json'); }
    if (!input || Array.isArray(input) || Object.keys(input).some(k => !['status', 'expectedVersion', 'reason', 'requestId'].includes(k))
      || !['active', 'suspended', 'banned'].includes(input.status) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
      || typeof input.reason !== 'string' || input.reason.trim().length < 2 || input.reason.length > 500 || /[\x00-\x1f\x7f]/.test(input.reason)
      || typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) return fail(422, 'invalid_governance_input');
    result = await changeGovernance(store, actor, target, { ...input, reason: input.reason.trim(), requestId: input.requestId.toLowerCase() });
  } else { response.setHeader('allow', 'GET, POST'); return fail(405, 'method_not_allowed'); }
  if (result.error) return fail(result.error === 'platform_role_required' ? 403 : result.error === 'not_found' ? 404 : 409, result.error);
  return sendJson(response, 200, result);
}
