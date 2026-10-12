import { createHash, randomUUID } from 'node:crypto';

import { buildStartRequest, buildStopRequest, normalizeResourceSpec } from './control-contract.mjs';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function requestHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function cleanReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 1 || reason.length > 500 || CONTROL_CHARACTERS.test(reason)) {
    throw new RuntimeControlError('runtime_reason_invalid');
  }
  return reason;
}

export class RuntimeControlError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RuntimeControlError';
    this.code = code;
  }
}

export class MemoryRuntimeControlStore {
  constructor(seed = {}) {
    this.agents = new Map((seed.agents ?? []).map((row) => [row.id, clone(row)]));
    this.governance = new Map((seed.governance ?? []).map((row) => [row.userId, clone(row)]));
    this.controls = new Map();
    this.runs = new Map();
    this.requests = new Map();
    this.routes = new Map();
    this.commands = [];
    this.locks = new Map();
    this.idFactory = seed.idFactory ?? randomUUID;
    this.clock = seed.now ?? Date.now;
  }

  control(agentId) {
    return clone(this.controls.get(agentId) ?? null);
  }

  run(runId) {
    return clone(this.runs.get(runId) ?? null);
  }

  route(agentId) {
    return clone(this.routes.get(agentId) ?? null);
  }

  commandsFor(agentId) {
    return clone(this.commands.filter((row) => row.aggregateId === agentId));
  }

  setGovernance(userId, status, version) {
    if (!['active', 'suspended', 'banned'].includes(status) || !Number.isSafeInteger(version) || version < 0) {
      throw new RuntimeControlError('governance_state_invalid');
    }
    this.governance.set(userId, { userId, status, version });
  }

  requestStart(input) {
    return this.#withAgentLock(input.agentId, () => this.#requestStart(input));
  }

  prepareCommand(input) {
    const command = this.#leasedCommand(input);
    return this.#withAgentLock(command.aggregateId, () => {
      this.#leasedCommand(input);
      const control = this.controls.get(command.aggregateId);
      this.#coordinateControl(control);
      const eligible = command.eventType === 'runtime.stop.requested'
        || (control.desiredState === 'running' && control.activeRunId === command.payload.runId
          && control.generation === command.payload.runGeneration);
      return eligible ? { eligible: true } : { eligible: false, reason: 'superseded' };
    });
  }

  #leasedCommand({ workerId, requestId, leaseAttempt }) {
    const command = this.commands.find(row => row.requestId === requestId);
    if (!command || command.status !== 'leased' || command.leasedBy !== workerId
      || command.attempts !== leaseAttempt || command.leaseUntil <= this.clock()) throw new RuntimeControlError('runtime_command_lease_lost');
    return command;
  }

  #receipt(input, eventType) {
    const command = this.#leasedCommand(input);
    if (command.eventType !== eventType || command.payload.agentId !== input.agentId
      || command.payload.runId !== input.runId || command.payload.runGeneration !== input.runGeneration
      || (eventType === 'runtime.stop.requested' && command.payload.fenceGeneration !== input.fenceGeneration)) {
      throw new RuntimeControlError('runtime_receipt_mismatch');
    }
    return command;
  }

  #coordinateControl(control) {
    const governance = this.#governance(control.ownerUserId);
    if (control.desiredState === 'running'
      && (governance.status !== 'active' || control.governanceVersion !== governance.version)) {
      return this.#requestStop({ actorUserId: null, agentId: control.agentId,
        requestId: randomUUID(),
        expectedGeneration: control.generation,
        reason: governance.status === 'active' ? 'governance_version_changed' : `account_${governance.status}` }, 'governance_stop');
    }
    return null;
  }

  requestStop(input) {
    return this.#withAgentLock(input.agentId, () => this.#requestStop(input, 'stop'));
  }

  commitStarted(input) {
    return this.#withAgentLock(input.agentId, () => this.#commitStarted(input));
  }

  commitStopped(input) {
    return this.#withAgentLock(input.agentId, () => this.#commitStopped(input));
  }

  async claimCommands(workerId, limit = 10) {
    if (!workerId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RuntimeControlError('runtime_claim_invalid');
    const now = this.clock();
    const rows = this.commands
      .filter((row) => row.eventType.startsWith('runtime.')
        && row.availableAt <= now
        && (row.status === 'queued' || (row.status === 'leased' && row.leaseUntil < now)))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit);
    for (const row of rows) {
      row.status = 'leased';
      row.leasedBy = workerId;
      row.leaseUntil = now + 60_000;
      row.attempts += 1;
      row.updatedAt = now;
    }
    return clone(rows);
  }

  async completeCommand({ workerId, commandId, leaseAttempt, status, errorCode = null }) {
    if (!['succeeded', 'failed', 'dead'].includes(status)) throw new RuntimeControlError('runtime_completion_invalid');
    const row = this.commands.find((item) => item.id === commandId && item.status === 'leased' && item.leasedBy === workerId);
    if (!row) return false;
    return this.#withAgentLock(row.aggregateId, () => {
      if (row.status !== 'leased' || row.leasedBy !== workerId || row.attempts !== leaseAttempt || row.leaseUntil <= this.clock()) return false;
      const control = this.controls.get(row.aggregateId);
      if (status === 'dead' && row.eventType === 'runtime.start.requested'
        && control.desiredState === 'running' && control.activeRunId === row.payload.runId) {
        this.#requestStop({ actorUserId: null, agentId: row.aggregateId, requestId: randomUUID(),
          expectedGeneration: control.generation, reason: 'start_attempts_exhausted' }, 'recovery_stop');
      }
      const now = this.clock();
      row.status = status === 'failed' ? 'queued' : status;
      row.availableAt = status === 'failed' ? now + Math.min(30_000, 250 * (2 ** row.attempts)) : row.availableAt;
      row.leasedBy = null;
      row.leaseUntil = null;
      row.lastError = errorCode;
      row.updatedAt = now;
      return true;
    });
  }

  async reconcileGovernance({ limit = 10 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RuntimeControlError('runtime_reconcile_invalid');
    const targets = [...this.controls.values()]
      .filter((control) => control.desiredState === 'running'
        && (this.#governance(control.ownerUserId).status !== 'active'
          || this.#governance(control.ownerUserId).version !== control.governanceVersion))
      .sort((left, right) => left.ownerUserId.localeCompare(right.ownerUserId) || left.agentId.localeCompare(right.agentId))
      .slice(0, limit);
    let stopped = 0;
    for (const control of targets) {
      const result = await this.#withAgentLock(control.agentId, () => this.#coordinateControl(control));
      if (result?.result === 'accepted') stopped += 1;
    }
    return { stopped, started: 0 };
  }

  async claimObservation(workerId) {
    if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 100 || CONTROL_CHARACTERS.test(workerId)) throw new RuntimeControlError('runtime_observation_invalid');
    for (const candidate of [...this.controls.values()].sort((a, b) => (a.observationNextAt ?? 0) - (b.observationNextAt ?? 0))) {
      const claimed = await this.#withAgentLock(candidate.agentId, () => {
        const now = this.clock();
        const c = this.controls.get(candidate.agentId); const run = this.runs.get(c.activeRunId);
        if (!run || (c.observation?.runId === run.id && c.observation.controlGeneration === c.generation && c.observation.until > now)
          || (c.lastObservation?.runId === run.id && c.lastObservation.controlGeneration === c.generation && c.observationNextAt > now)) return null;
        const lease = { workerId, leaseToken: randomUUID(), agentId: c.agentId, runId: run.id,
          runGeneration: run.runGeneration, controlGeneration: c.generation, until: now + 60000 };
        c.observation = lease; return clone(lease);
      });
      if (claimed) return claimed;
    }
    return null;
  }

  recordObservation(input) {
    return this.#withAgentLock(input.agentId, () => {
      const c = this.controls.get(input.agentId); const lease = c?.observation;
      if (!lease || lease.workerId !== input.workerId || lease.leaseToken !== input.leaseToken || lease.until <= this.clock()) {
        throw new RuntimeControlError('runtime_observation_lease_lost');
      }
      if (c.activeRunId !== input.runId || c.generation !== input.controlGeneration || lease.runId !== input.runId
        || lease.controlGeneration !== input.controlGeneration || lease.runGeneration !== input.runGeneration) throw new RuntimeControlError('runtime_observation_superseded');
      const run = this.runs.get(input.runId);
      if (!run || run.runGeneration !== input.runGeneration || !['starting', 'running', 'stopping', 'stopped', 'absent', 'error'].includes(input.status)
        || !Number.isFinite(Date.parse(input.observedAt))) throw new RuntimeControlError('runtime_observation_invalid');
      if (input.status === 'running' && run.status === 'running'
        && (run.containerRef !== input.orchestratorRef || run.runtimeUrl !== input.runtimeUrl)) throw new RuntimeControlError('runtime_observation_identity_conflict');
      if (input.status === 'running' && (typeof input.orchestratorRef !== 'string' || input.orchestratorRef.length < 1
        || input.orchestratorRef.length > 500 || CONTROL_CHARACTERS.test(input.orchestratorRef)
        || typeof input.runtimeUrl !== 'string' || input.runtimeUrl.length > 2048 || !/^https?:\/\/[^\s]+$/.test(input.runtimeUrl))) throw new RuntimeControlError('runtime_observation_invalid');
      const governance = this.#governance(c.ownerUserId);
      const now = this.clock(); const iso = new Date(now).toISOString();
      const successfulAt = input.status === 'error' ? (c.lastObservation?.runId === run.id ? c.lastObservation.successfulAt : null) : now;
      c.lastObservation = { runId: run.id, controlGeneration: c.generation, status: input.status, at: now, successfulAt };
      c.observation = null; c.observationNextAt = now + 10000;
      if (['stopped', 'absent'].includes(input.status)) {
        const expectedGeneration = c.generation; const requestId = randomUUID();
        if (c.desiredState === 'running') c.generation++;
        Object.assign(c, { desiredState: 'stopped', activeRunId: null, changedBy: null, lastRequestId: requestId, changeReason: 'observed_terminal', updatedAt: iso });
        Object.assign(run, { status: 'stopped', desiredState: 'stopped', stopReason: run.stopReason ?? 'observed_terminal', stopConfirmedAt: iso, stoppedAt: iso, updatedAt: iso });
        if (this.routes.get(c.agentId)?.routeVersion === run.runGeneration) this.routes.delete(c.agentId);
        this.agents.get(c.agentId).status = 'stopped';
        this.#recordRequest({ requestId, requestHash: requestHash({ runId: run.id, status: input.status }), organizationId: c.organizationId,
          agentId: c.agentId, action: 'recovery_stop', expectedGeneration,
          result: { result: 'accepted', generation: c.generation, runId: run.id }, actorUserId: null, reason: 'observed_terminal' });
        return { result: 'stopped' };
      }
      const route = this.routes.get(c.agentId);
      if (input.status === 'running' && c.desiredState === 'running' && governance.status === 'active' && governance.version === c.governanceVersion
        && route?.runId === run.id && route.routeVersion === run.runGeneration && run.containerRef === input.orchestratorRef && route.runtimeUrl === input.runtimeUrl) {
        route.lastSeenAt = iso; route.updatedAt = iso;
      }
      return { result: 'observed' };
    });
  }

  async supervisionSnapshot() {
    const summary = { active: 0, stopping: 0, stopOverdue: 0, deadPending: 0, observationErrors: 0, observationStale: 0 };
    for (const c of this.controls.values()) {
      const run = this.runs.get(c.activeRunId); if (!run) continue;
      summary.active++;
      if (run.status === 'stopping') { summary.stopping++; if (this.clock() - Date.parse(run.stopRequestedAt) > 60000) summary.stopOverdue++; }
      if (this.commands.some(q => q.status === 'dead' && q.payload.runId === run.id)) summary.deadPending++;
      const observation = c.lastObservation?.runId === run.id ? c.lastObservation : null;
      if (observation?.status === 'error' || (run.status === 'running' && observation && observation.status !== 'running')) summary.observationErrors++;
      if (this.clock() - (observation?.successfulAt ?? Date.parse(run.createdAt)) > 60000) summary.observationStale++;
    }
    return summary;
  }

  #governance(userId) {
    const value = this.governance.has(userId) ? this.governance.get(userId) : { userId, status: 'active', version: 0 };
    if (!value || !['active', 'suspended', 'banned'].includes(value.status) || !Number.isSafeInteger(value.version)) {
      throw new RuntimeControlError('governance_unavailable');
    }
    return value;
  }

  #agentForActor(agentId, actorUserId, allowSystem = false) {
    const agent = this.agents.get(agentId);
    if (!agent || (!allowSystem && agent.ownerUserId !== actorUserId)) throw new RuntimeControlError('runtime_agent_not_found');
    return agent;
  }

  #currentControl(agent) {
    return this.controls.get(agent.id) ?? null;
  }

  #checkReplay(requestId, hash) {
    const existing = this.requests.get(requestId);
    if (!existing) return null;
    if (existing.requestHash !== hash) throw new RuntimeControlError('idempotency_conflict');
    return { ...clone(existing.result), replayed: true };
  }

  #recordRequest({ requestId, requestHash: hash, organizationId, agentId, action, expectedGeneration, result, actorUserId, reason }) {
    this.requests.set(requestId, {
      requestId,
      requestHash: hash,
      organizationId,
      agentId,
      action,
      expectedGeneration,
      resultGeneration: result.generation,
      resultCode: result.result,
      runId: result.runId,
      actorUserId,
      reason,
      occurredAt: this.clock(),
      result: clone(result),
    });
  }

  #enqueue({ organizationId, agentId, eventType, payload, requestId }) {
    const now = this.clock();
    const command = {
      id: this.idFactory(),
      organizationId,
      aggregateType: 'runtime',
      aggregateId: agentId,
      eventType,
      payload: clone(payload),
      requestId,
      status: 'queued',
      attempts: 0,
      availableAt: now,
      leaseUntil: null,
      leasedBy: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.commands.push(command);
    return command;
  }

  #requestStart(input) {
    const agent = this.#agentForActor(input.agentId, input.actorUserId);
    const normalizedResources = normalizeResourceSpec(input.resourceSpec);
    if (!['pi', 'dsh'].includes(agent.engine)) throw new RuntimeControlError('runtime_engine_invalid');
    const hash = requestHash({ action: 'start', agentId: agent.id, expectedGeneration: input.expectedGeneration, resourceSpec: normalizedResources });
    const replay = this.#checkReplay(input.requestId, hash);
    if (replay) return replay;
    if (this.#governance(agent.ownerUserId).status !== 'active') throw new RuntimeControlError('account_runtime_forbidden');

    const current = this.#currentControl(agent);
    if (current?.desiredState === 'running' && current.governanceVersion !== this.#governance(agent.ownerUserId).version) {
      throw new RuntimeControlError('account_runtime_forbidden');
    }
    const currentGeneration = current?.generation ?? 0;
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration !== currentGeneration) {
      throw new RuntimeControlError('runtime_generation_conflict');
    }
    if (current?.desiredState === 'running') {
      const result = { result: 'noop', generation: current.generation, runId: current.activeRunId, replayed: false, commandRequestId: null };
      current.lastRequestId = input.requestId;
      current.updatedAt = new Date(this.clock()).toISOString();
      this.#recordRequest({ requestId: input.requestId, requestHash: hash, organizationId: agent.organizationId, agentId: agent.id, action: 'start', expectedGeneration: input.expectedGeneration, result, actorUserId: input.actorUserId, reason: 'already_running' });
      return clone(result);
    }
    if (current?.activeRunId) throw new RuntimeControlError('runtime_stop_pending');

    const generation = currentGeneration + 1;
    const runId = this.idFactory();
    buildStartRequest({ agentId: agent.id, runId, runGeneration: generation, engine: agent.engine, resourceSpec: normalizedResources });
    const now = new Date(this.clock()).toISOString();
    const control = current ?? {
      agentId: agent.id,
      organizationId: agent.organizationId,
      ownerUserId: agent.ownerUserId,
      createdAt: now,
    };
    Object.assign(control, {
      desiredState: 'running',
      generation,
      activeRunId: runId,
      resourceSpec: normalizedResources,
      governanceVersion: this.#governance(agent.ownerUserId).version,
      lastRequestId: input.requestId,
      changedBy: input.actorUserId,
      changeReason: 'start',
      updatedAt: now,
    });
    this.controls.set(agent.id, control);
    this.runs.set(runId, {
      id: runId,
      organizationId: agent.organizationId,
      agentId: agent.id,
      engine: agent.engine,
      templateVersion: agent.templateVersion ?? 1,
      status: 'initializing',
      desiredState: 'running',
      runGeneration: generation,
      containerRef: null,
      runtimeUrl: null,
      subdomain: agent.subdomain ?? `agent-${agent.id}.localhost`,
      stopReason: null,
      stopRequestedAt: null,
      stopConfirmedAt: null,
      lastCommandRequestId: input.requestId,
      startedAt: null,
      stoppedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.#enqueue({
      organizationId: agent.organizationId,
      agentId: agent.id,
      eventType: 'runtime.start.requested',
      requestId: input.requestId,
      payload: { agentId: agent.id, runId, runGeneration: generation, engine: agent.engine, resourceSpec: normalizedResources },
    });
    const result = { result: 'accepted', generation, runId, replayed: false, commandRequestId: input.requestId };
    this.#recordRequest({ requestId: input.requestId, requestHash: hash, organizationId: agent.organizationId, agentId: agent.id, action: 'start', expectedGeneration: input.expectedGeneration, result, actorUserId: input.actorUserId, reason: 'start' });
    return clone(result);
  }

  #requestStop(input, action) {
    const system = action === 'governance_stop' || action === 'recovery_stop';
    const agent = this.#agentForActor(input.agentId, input.actorUserId, system);
    const reason = cleanReason(input.reason);
    const hash = requestHash({ action, agentId: agent.id, expectedGeneration: input.expectedGeneration, reason });
    const replay = this.#checkReplay(input.requestId, hash);
    if (replay) return replay;

    const control = this.#currentControl(agent);
    const currentGeneration = control?.generation ?? 0;
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration !== currentGeneration) {
      throw new RuntimeControlError('runtime_generation_conflict');
    }
    if (!control || control.desiredState === 'stopped') {
      const result = { result: 'noop', generation: currentGeneration, runId: control?.activeRunId ?? null, replayed: false, commandRequestId: null };
      this.#recordRequest({ requestId: input.requestId, requestHash: hash, organizationId: agent.organizationId, agentId: agent.id, action, expectedGeneration: input.expectedGeneration, result, actorUserId: input.actorUserId, reason });
      return clone(result);
    }

    const run = control.activeRunId ? this.runs.get(control.activeRunId) : null;
    const generation = currentGeneration + 1;
    const now = new Date(this.clock()).toISOString();
    control.desiredState = 'stopped';
    control.generation = generation;
    control.lastRequestId = input.requestId;
    control.changedBy = system ? null : input.actorUserId;
    control.changeReason = reason;
    control.updatedAt = now;
    this.routes.delete(agent.id);
    if (run) {
      run.status = 'stopping';
      run.desiredState = 'stopped';
      run.stopReason = reason;
      run.stopRequestedAt = now;
      run.lastCommandRequestId = input.requestId;
      run.updatedAt = now;
      const payload = buildStopRequest({
        agentId: agent.id,
        runId: run.id,
        runGeneration: run.runGeneration,
        fenceGeneration: generation,
        reason,
      });
      this.#enqueue({ organizationId: agent.organizationId, agentId: agent.id, eventType: 'runtime.stop.requested', requestId: input.requestId, payload });
    }
    const result = { result: 'accepted', generation, runId: run?.id ?? null, replayed: false, commandRequestId: run ? input.requestId : null };
    this.#recordRequest({ requestId: input.requestId, requestHash: hash, organizationId: agent.organizationId, agentId: agent.id, action, expectedGeneration: input.expectedGeneration, result, actorUserId: input.actorUserId, reason });
    return clone(result);
  }

  #commitStarted(input) {
    this.#receipt(input, 'runtime.start.requested');
    const run = this.runs.get(input.runId);
    if (!run || run.agentId !== input.agentId || run.runGeneration !== input.runGeneration) {
      throw new RuntimeControlError('runtime_run_not_found');
    }
    const control = this.controls.get(input.agentId);
    this.#coordinateControl(control);
    const now = new Date(this.clock()).toISOString();
    const current = control.desiredState === 'running'
      && control.generation === run.runGeneration
      && control.activeRunId === run.id
      && this.#governance(control.ownerUserId).status === 'active';
    if (current) {
      if (run.status === 'running' && (run.containerRef !== input.orchestratorRef || run.runtimeUrl !== input.runtimeUrl)) {
        throw new RuntimeControlError('orchestrator_identity_conflict');
      }
      run.status = 'running';
      run.containerRef = input.orchestratorRef;
      run.runtimeUrl = input.runtimeUrl;
      run.startedAt ??= now;
      run.updatedAt = now;
      this.routes.set(run.agentId, {
        agentId: run.agentId,
        organizationId: run.organizationId,
        runId: run.id,
        runtimeUrl: input.runtimeUrl,
        routeVersion: run.runGeneration,
        healthStatus: 'healthy',
        lastSeenAt: now,
        updatedAt: now,
      });
      return { result: 'committed', generation: control.generation, runId: run.id };
    }
    if (run.status !== 'stopped') {
      run.status = 'stopping';
      run.desiredState = 'stopped';
      run.containerRef = input.orchestratorRef;
      run.runtimeUrl = input.runtimeUrl;
      run.stopReason ??= 'stale_start';
      run.stopRequestedAt ??= now;
      run.updatedAt = now;
      if (this.routes.get(run.agentId)?.routeVersion === run.runGeneration) this.routes.delete(run.agentId);
      this.#ensureCompensatingStop(run, control);
    }
    return { result: 'stale_stop_enqueued', generation: control.generation, runId: run.id };
  }

  #ensureCompensatingStop(run, control) {
    const exists = this.commands.some((row) => row.eventType === 'runtime.stop.requested' && row.payload.runId === run.id);
    if (exists) return;
    const requestId = this.idFactory();
    const fenceGeneration = Math.max(control.generation, run.runGeneration + 1);
    const payload = buildStopRequest({
      agentId: run.agentId,
      runId: run.id,
      runGeneration: run.runGeneration,
      fenceGeneration,
      reason: 'stale_start',
    });
    this.#enqueue({ organizationId: run.organizationId, agentId: run.agentId, eventType: 'runtime.stop.requested', requestId, payload });
  }

  #commitStopped(input) {
    this.#receipt(input, 'runtime.stop.requested');
    const run = this.runs.get(input.runId);
    if (!run || run.agentId !== input.agentId || run.runGeneration !== input.runGeneration) {
      throw new RuntimeControlError('runtime_run_not_found');
    }
    if (!['stopped', 'absent'].includes(input.status)
      || !Number.isSafeInteger(input.fenceGeneration)
      || input.fenceGeneration <= input.runGeneration
      || !Number.isFinite(Date.parse(input.confirmedAt))) throw new RuntimeControlError('stop_confirmation_invalid');
    const now = new Date(this.clock()).toISOString();
    run.status = 'stopped';
    run.desiredState = 'stopped';
    run.stopConfirmedAt = input.confirmedAt;
    run.stoppedAt = input.confirmedAt;
    run.updatedAt = now;
    const route = this.routes.get(run.agentId);
    if (route?.runId === run.id && route.routeVersion === run.runGeneration) this.routes.delete(run.agentId);
    const control = this.controls.get(run.agentId);
    if (control?.activeRunId === run.id) {
      control.activeRunId = null;
      control.updatedAt = now;
    }
    return { result: 'committed', generation: control?.generation ?? input.fenceGeneration, runId: run.id };
  }

  async #withAgentLock(agentId, operation) {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.locks.set(agentId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(agentId) === current) this.locks.delete(agentId);
    }
  }
}
