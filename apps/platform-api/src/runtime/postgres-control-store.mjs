import { RuntimeControlError } from './control-store.mjs';
import { normalizeResourceSpec } from './control-contract.mjs';

const DATABASE_ERROR_CODES = Object.freeze({
  '22023': 'runtime_control_invalid',
  '23503': 'runtime_control_reference_invalid',
  '23505': 'runtime_control_conflict',
  '42501': 'runtime_control_forbidden',
  '55P03': 'runtime_control_busy',
  '57014': 'runtime_control_timeout',
});

function safeDatabaseCode(error) {
  return DATABASE_ERROR_CODES[error?.code] ?? 'runtime_control_unavailable';
}

function controlResult(result) {
  if (result?.error) throw new RuntimeControlError(result.error);
  return result;
}

function commandFromRow(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    requestId: row.request_id,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseUntil: row.lease_until,
    leasedBy: row.leased_by,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresRuntimeControlStore {
  constructor({ pool }) {
    if (!pool?.query) throw new TypeError('runtime_control_pool_required');
    this.pool = pool;
  }

  requestStart(input) {
    const resources = normalizeResourceSpec(input.resourceSpec);
    return this.#json('runtime_control_request_start', [
      input.actorUserId,
      input.agentId,
      input.requestId,
      input.expectedGeneration,
      resources.cpuMillis,
      resources.memoryBytes,
      resources.pidsLimit,
      resources.idleTtlSeconds,
    ]);
  }

  requestStop(input) {
    return this.#json('runtime_control_request_stop', [
      input.actorUserId,
      input.agentId,
      input.requestId,
      input.expectedGeneration,
      input.reason,
    ]);
  }

  async claimCommands(workerId, limit = 10) {
    try {
      const result = await this.pool.query('SELECT * FROM runtime_control_claim($1,$2)', [workerId, limit]);
      return result.rows.map(commandFromRow);
    } catch (error) {
      throw new RuntimeControlError(safeDatabaseCode(error));
    }
  }

  async completeCommand({ workerId, commandId, status, errorCode = null }) {
    try {
      const result = await this.pool.query(
        'SELECT runtime_control_complete($1,$2,$3,$4) AS ok',
        [workerId, commandId, status, errorCode],
      );
      return result.rows[0]?.ok === true;
    } catch (error) {
      throw new RuntimeControlError(safeDatabaseCode(error));
    }
  }

  commitStarted(input) {
    return this.#json('runtime_control_commit_started', [
      input.workerId,
      input.requestId,
      input.agentId,
      input.runId,
      input.runGeneration,
      input.orchestratorRef,
      input.runtimeUrl,
    ]);
  }

  commitStopped(input) {
    return this.#json('runtime_control_commit_stopped', [
      input.workerId,
      input.requestId,
      input.agentId,
      input.runId,
      input.runGeneration,
      input.fenceGeneration,
      input.status,
      input.confirmedAt,
    ]);
  }

  reconcileGovernance({ workerId, limit = 10 }) {
    return this.#json('runtime_control_reconcile_governance', [workerId, limit]);
  }

  async #json(functionName, values) {
    const parameters = values.map((_, index) => `$${index + 1}`).join(',');
    try {
      const result = await this.pool.query(`SELECT ${functionName}(${parameters}) AS result`, values);
      return controlResult(result.rows[0]?.result);
    } catch (error) {
      if (error instanceof RuntimeControlError) throw error;
      throw new RuntimeControlError(safeDatabaseCode(error));
    }
  }
}
