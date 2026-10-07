import { randomUUID } from 'node:crypto';
import { rollbackForRelease } from '../postgres-transaction.mjs';

export const TASK_LIMITS = Object.freeze({ user: 5, global: 10, worker: 5, queueUser: 20, queueGlobal: 200, leaseMs: 15000, attempts: 3 });
const active = t => t.status === 'queued' || t.status === 'running';
const tenant = t => JSON.stringify([t.organizationId, t.userId]);
const owns = (scope, t) => t && scope.userId === t.userId && scope.organizationId === t.organizationId;
const clone = value => value == null ? value : structuredClone(value);
export class TaskError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Both stores run the same transitions; PostgreSQL holds a short global decision lock.
class TaskStore {
  constructor({ governance } = {}) { this.governance = governance; }

  async governanceFor(userId, context) {
    const cache = context?.governanceCache;
    if (cache?.has(userId)) return cache.get(userId);
    try {
      const value = this.governance
        ? await this.governance.get(userId, context)
        : context?.query
          ? (await context.query('SELECT platform_scheduler_account_access($1) AS result', [userId])).rows[0]?.result
          : { status: 'active', version: 0 };
      if (!value || !['active', 'suspended', 'banned'].includes(value.status) || !Number.isSafeInteger(value.version) || value.version < 0) {
        throw new Error('invalid_account_state');
      }
      cache?.set(userId, value);
      return value;
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw new TaskError('governance_unavailable');
    }
  }

  async requireActive(scope, context) {
    const account = await this.governanceFor(scope.userId, context);
    if (account.status !== 'active') throw new TaskError('account_' + account.status);
    return account;
  }

  async reconcileGovernance(state, now, context) {
    const owners = new Map();
    for (const task of state.tasks) {
      if (!active(task)) continue;
      if (!owners.has(task.userId)) owners.set(task.userId, []);
      owners.get(task.userId).push(task);
    }
    for (const [userId, tasks] of owners) {
      const account = await this.governanceFor(userId, context);
      for (const task of tasks) {
        if (account.status === 'active' && account.version === task.governanceVersion) continue;
        const cancelReason = account.status === 'banned'
          ? 'account_banned'
          : account.status === 'suspended'
            ? 'account_suspended'
            : 'governance_changed';
        Object.assign(task, { status: 'cancelled', cancelReason, cancelledAt: now, workerId: null, leaseUntil: null, updatedAt: now });
      }
    }
  }

  async submit(scope, key, input) {
    if (!scope?.userId || !scope?.organizationId || typeof key !== 'string' || !key.trim() || key.length > 128 ||
        !input || !Number.isInteger(input.durationMs) || input.durationMs < 2000 || input.durationMs > 5000 ||
        !['success', 'failure'].includes(input.outcome)) throw new TaskError('invalid_task');
    return this.mutate({ scope, key }, async (state, now, context) => {
      const account = await this.requireActive(scope, context);
      const existing = state.tasks.find(t => owns(scope, t) && t.key === key);
      if (existing) {
        if (existing.durationMs !== input.durationMs || existing.outcome !== input.outcome) throw new TaskError('idempotency_conflict');
        return clone(existing);
      }
      const queued = state.tasks.filter(t => t.status === 'queued');
      if (queued.length >= TASK_LIMITS.queueGlobal || queued.filter(t => t.userId === scope.userId).length >= TASK_LIMITS.queueUser) throw new TaskError('queue_full');
      const task = { id: randomUUID(), ...scope, key, durationMs: input.durationMs, outcome: input.outcome,
        status: 'queued', attempt: 0, governanceVersion: account.version, workerId: null, leaseUntil: null,
        cancelReason: null, cancelledAt: null, createdAt: now, updatedAt: now };
      state.tasks.push(task);
      return clone(task);
    });
  }

  async claim(workerId) {
    if (typeof workerId !== 'string' || !workerId || workerId.length > 128) throw new TaskError('invalid_worker');
    return this.mutate({}, async (state, now) => {
      const running = state.tasks.filter(t => t.status === 'running');
      if (running.length >= TASK_LIMITS.global || running.filter(t => t.workerId === workerId).length >= TASK_LIMITS.worker) return null;
      const eligible = state.tasks.filter(t => t.status === 'queued' && running.filter(r => r.userId === t.userId).length < TASK_LIMITS.user);
      eligible.sort((a, b) => (state.served[tenant(a)] ?? 0) - (state.served[tenant(b)] ?? 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const t = eligible[0];
      if (!t) return null;
      state.served[tenant(t)] = Math.max(0, ...Object.values(state.served)) + 1;
      Object.assign(t, { status: 'running', workerId, attempt: t.attempt + 1, leaseUntil: now + TASK_LIMITS.leaseMs, updatedAt: now });
      return clone(t);
    });
  }

  async heartbeat(claim) { return this.workerChange(claim, null); }
  async finish(claim, status) {
    if (!['succeeded', 'failed'].includes(status)) throw new TaskError('invalid_status');
    return this.workerChange(claim, status);
  }
  async workerChange(claim, status) {
    return this.mutate({ id: claim.id }, async (state, now) => {
      const t = state.tasks.find(t => t.id === claim.id);
      if (!t || t.status !== 'running' || t.workerId !== claim.workerId || t.attempt !== claim.attempt || t.leaseUntil <= now) return false;
      t.updatedAt = now;
      if (status) { t.status = status; t.workerId = null; t.leaseUntil = null; }
      else t.leaseUntil = now + TASK_LIMITS.leaseMs;
      return true;
    });
  }
  async cancel(scope, id) {
    return this.mutate({ scope, id }, async (state, now, context) => {
      await this.requireActive(scope, context);
      const t = state.tasks.find(t => t.id === id && owns(scope, t));
      if (!t) return null;
      if (active(t)) Object.assign(t, { status: 'cancelled', cancelReason: 'user_requested', cancelledAt: now, workerId: null, leaseUntil: null, updatedAt: now });
      return clone(t);
    });
  }
}

function recover(state, now) {
  for (const t of state.tasks) if (t.status === 'running' && t.leaseUntil <= now) {
    Object.assign(t, { status: t.attempt >= TASK_LIMITS.attempts ? 'failed' : 'queued', workerId: null, leaseUntil: null, updatedAt: now });
  }
}

export class MemoryTaskStore extends TaskStore {
  constructor({ clock = Date.now, governance } = {}) {
    super({ governance });
    this.clock = clock;
    this.state = { tasks: [], served: {} };
    this.mutationQueue = Promise.resolve();
  }
  async mutate(filter, fn) {
    const run = this.mutationQueue.then(async () => {
      const state = clone(this.state), now = this.clock();
      const context = { governanceCache: new Map() };
      // Governance cancellation must precede lease recovery, including the final attempt.
      await this.reconcileGovernance(state, now, context);
      recover(state, now);
      const result = await fn(state, now, context);
      this.state = state;
      return result;
    });
    this.mutationQueue = run.catch(() => {});
    return run;
  }
  async get(scope, id) { return clone(this.state.tasks.find(t => t.id === id && owns(scope, t)) ?? null); }
  async list(scope) { return clone(this.state.tasks.filter(t => owns(scope, t)).sort((a,b) => b.createdAt-a.createdAt || b.id.localeCompare(a.id)).slice(0,100)); }
}

const fromRow = ({ organization_id, user_id, governance_version, cancel_reason, cancelled_at, ...row }) => ({
  ...row,
  organizationId: organization_id,
  userId: user_id,
  governanceVersion: governance_version,
  cancelReason: cancel_reason,
  cancelledAt: cancelled_at == null ? null : new Date(cancelled_at).getTime(),
});
export class PostgresTaskStore extends TaskStore {
  constructor(pool, { governance } = {}) { super({ governance }); this.pool = pool; }
  async scoped(scope, fn) {
    const c = await this.pool.connect();
    let releaseError;
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.organization_id',$1,true),set_config('app.user_id',$2,true)", [scope.organizationId,scope.userId]);
      const result = await fn(c); await c.query('COMMIT'); return result;
    } catch (e) { releaseError = await rollbackForRelease(c); throw e; } finally { c.release(releaseError); }
  }
  async get(scope,id) { return this.scoped(scope,async c => {
    const r = await c.query('SELECT * FROM simulation_tasks WHERE id=$1 AND organization_id=$2 AND user_id=$3',[id,scope.organizationId,scope.userId]);
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }); }
  async list(scope) { return this.scoped(scope, async c => (await c.query('SELECT * FROM simulation_tasks WHERE organization_id=$1 AND user_id=$2 ORDER BY "createdAt" DESC,id DESC LIMIT 100',[scope.organizationId,scope.userId])).rows.map(fromRow)); }
  async mutate(filter, fn) {
    const c = await this.pool.connect();
    let releaseError;
    try {
      // A lock wait must not leave us reading a pre-governance transaction snapshot.
      await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await c.query("SET LOCAL lock_timeout='5s'");
      await c.query("SELECT pg_advisory_xact_lock(734033),set_config('app.simulation_worker','on',true)");
      // Match the schema-qualified lock key in platform_governance_change (036/037).
      // Read state in subsequent statements so a waited-for change is visible.
      // Holding the shared lock through COMMIT also fences governance against stale receipts.
      await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended(format('%I:governance:changes',current_schema()),0))");
      const context = { query: c.query.bind(c), governanceCache: new Map() };
      const now = Number((await c.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS now')).rows[0].now);
      const rows = (await c.query(
        `SELECT * FROM simulation_tasks WHERE status IN ('queued','running') OR id=$1 OR (organization_id=$2 AND user_id=$3 AND "key"=$4)`,
        [filter.id ?? null, filter.scope?.organizationId ?? null, filter.scope?.userId ?? null, filter.key ?? null])).rows.map(fromRow);
      const served = {};
      for (const row of (await c.query("SELECT s.* FROM simulation_tenants s WHERE EXISTS (SELECT 1 FROM simulation_tasks t WHERE t.organization_id=s.organization_id AND t.user_id=s.user_id AND t.status IN ('queued','running'))")).rows) {
        served[JSON.stringify([row.organization_id,row.user_id])] = Number(row.served);
      }
      const state = { tasks: rows, served }, before = new Map(rows.map(t => [t.id,JSON.stringify(t)])), oldServed = {...served};
      await this.reconcileGovernance(state,now,context);
      recover(state,now);
      const result = await fn(state,now,context);
      for (const t of state.tasks) {
        if (before.get(t.id) === JSON.stringify(t)) continue;
        await c.query('INSERT INTO simulation_tasks (id,organization_id,user_id,"key","durationMs",outcome,status,attempt,governance_version,"workerId","leaseUntil",cancel_reason,cancelled_at,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,attempt=EXCLUDED.attempt,governance_version=EXCLUDED.governance_version,"workerId"=EXCLUDED."workerId","leaseUntil"=EXCLUDED."leaseUntil",cancel_reason=EXCLUDED.cancel_reason,cancelled_at=EXCLUDED.cancelled_at,"updatedAt"=EXCLUDED."updatedAt"',
          [t.id,t.organizationId,t.userId,t.key,t.durationMs,t.outcome,t.status,t.attempt,t.governanceVersion,t.workerId,t.leaseUntil,t.cancelReason,t.cancelledAt == null ? null : new Date(t.cancelledAt),t.createdAt,t.updatedAt]);
      }
      for (const [key,value] of Object.entries(served)) if (oldServed[key] !== value) {
        const [org,user] = JSON.parse(key);
        await c.query('INSERT INTO simulation_tenants(organization_id,user_id,served) VALUES ($1,$2,$3) ON CONFLICT (organization_id,user_id) DO UPDATE SET served=EXCLUDED.served',[org,user,value]);
      }
      await c.query('COMMIT'); return result;
    } catch(e) { releaseError = await rollbackForRelease(c); throw e; } finally { c.release(releaseError); }
  }
}
