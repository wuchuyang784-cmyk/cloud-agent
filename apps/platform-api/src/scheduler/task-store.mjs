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
  async submit(scope, key, input) {
    if (!scope?.userId || !scope?.organizationId || typeof key !== 'string' || !key.trim() || key.length > 128 ||
        !input || !Number.isInteger(input.durationMs) || input.durationMs < 2000 || input.durationMs > 5000 ||
        !['success', 'failure'].includes(input.outcome)) throw new TaskError('invalid_task');
    return this.mutate({ scope, key }, (state, now) => {
      const existing = state.tasks.find(t => owns(scope, t) && t.key === key);
      if (existing) {
        if (existing.durationMs !== input.durationMs || existing.outcome !== input.outcome) throw new TaskError('idempotency_conflict');
        return clone(existing);
      }
      const queued = state.tasks.filter(t => t.status === 'queued');
      if (queued.length >= TASK_LIMITS.queueGlobal || queued.filter(t => t.userId === scope.userId).length >= TASK_LIMITS.queueUser) throw new TaskError('queue_full');
      const task = { id: randomUUID(), ...scope, key, durationMs: input.durationMs, outcome: input.outcome,
        status: 'queued', attempt: 0, workerId: null, leaseUntil: null, createdAt: now, updatedAt: now };
      state.tasks.push(task);
      return clone(task);
    });
  }

  async claim(workerId) {
    if (typeof workerId !== 'string' || !workerId || workerId.length > 128) throw new TaskError('invalid_worker');
    return this.mutate({}, (state, now) => {
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
    return this.mutate({ id: claim.id }, (state, now) => {
      const t = state.tasks.find(t => t.id === claim.id);
      if (!t || t.status !== 'running' || t.workerId !== claim.workerId || t.attempt !== claim.attempt || t.leaseUntil <= now) return false;
      t.updatedAt = now;
      if (status) { t.status = status; t.workerId = null; t.leaseUntil = null; }
      else t.leaseUntil = now + TASK_LIMITS.leaseMs;
      return true;
    });
  }
  async cancel(scope, id) {
    return this.mutate({ scope, id }, (state, now) => {
      const t = state.tasks.find(t => t.id === id && owns(scope, t));
      if (!t) return null;
      if (active(t)) Object.assign(t, { status: 'cancelled', workerId: null, leaseUntil: null, updatedAt: now });
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
  constructor({ clock = Date.now } = {}) { super(); this.clock = clock; this.state = { tasks: [], served: {} }; }
  async mutate(filter, fn) {
    const state = clone(this.state), now = this.clock();
    recover(state, now);
    const result = fn(state, now);
    this.state = state;
    return result;
  }
  async get(scope, id) { return clone(this.state.tasks.find(t => t.id === id && owns(scope, t)) ?? null); }
  async list(scope) { return clone(this.state.tasks.filter(t => owns(scope, t)).sort((a,b) => b.createdAt-a.createdAt || b.id.localeCompare(a.id)).slice(0,100)); }
}

const fromRow = ({ organization_id, user_id, ...row }) => ({ ...row, organizationId: organization_id, userId: user_id });
export class PostgresTaskStore extends TaskStore {
  constructor(pool) { super(); this.pool = pool; }
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
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout='5s'");
      await c.query("SELECT pg_advisory_xact_lock(734033),set_config('app.simulation_worker','on',true)");
      const now = Number((await c.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS now')).rows[0].now);
      const rows = (await c.query(
        `SELECT * FROM simulation_tasks WHERE status IN ('queued','running') OR id=$1 OR (organization_id=$2 AND user_id=$3 AND "key"=$4)`,
        [filter.id ?? null, filter.scope?.organizationId ?? null, filter.scope?.userId ?? null, filter.key ?? null])).rows.map(fromRow);
      const served = {};
      for (const row of (await c.query("SELECT s.* FROM simulation_tenants s WHERE EXISTS (SELECT 1 FROM simulation_tasks t WHERE t.organization_id=s.organization_id AND t.user_id=s.user_id AND t.status IN ('queued','running'))")).rows) {
        served[JSON.stringify([row.organization_id,row.user_id])] = Number(row.served);
      }
      const state = { tasks: rows, served }, before = new Map(rows.map(t => [t.id,JSON.stringify(t)])), oldServed = {...served};
      recover(state,now);
      const result = fn(state,now);
      for (const t of state.tasks) {
        if (before.get(t.id) === JSON.stringify(t)) continue;
        await c.query('INSERT INTO simulation_tasks (id,organization_id,user_id,"key","durationMs",outcome,status,attempt,"workerId","leaseUntil","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,attempt=EXCLUDED.attempt,"workerId"=EXCLUDED."workerId","leaseUntil"=EXCLUDED."leaseUntil","updatedAt"=EXCLUDED."updatedAt"',
          [t.id,t.organizationId,t.userId,t.key,t.durationMs,t.outcome,t.status,t.attempt,t.workerId,t.leaseUntil,t.createdAt,t.updatedAt]);
      }
      for (const [key,value] of Object.entries(served)) if (oldServed[key] !== value) {
        const [org,user] = JSON.parse(key);
        await c.query('INSERT INTO simulation_tenants(organization_id,user_id,served) VALUES ($1,$2,$3) ON CONFLICT (organization_id,user_id) DO UPDATE SET served=EXCLUDED.served',[org,user,value]);
      }
      await c.query('COMMIT'); return result;
    } catch(e) { releaseError = await rollbackForRelease(c); throw e; } finally { c.release(releaseError); }
  }
}
