import { buildStartRequest, buildStopRequest } from '../control-contract.mjs';

const identity = row => ({ agentId: row.agentId, runId: row.runId, runGeneration: row.runGeneration });
function matches(row, spec) {
  if (row.agentId !== spec.agentId || row.runGeneration !== spec.runGeneration) throw new Error('identity_conflict');
}

export class Orchestrator {
  constructor({ ledger, docker, clock = Date.now }) { this.ledger = ledger; this.docker = docker; this.clock = clock; }
  async start(input) {
    const spec = buildStartRequest(input);
    if (spec.engine !== 'pi') throw new Error('engine_unsupported');
    return this.ledger.withRun(spec.runId, async tx => {
      let row = await tx.read();
      if (row) {
        matches(row, spec);
        if (row.terminal) throw new Error('run_fenced');
        if (JSON.stringify(buildStartRequest(row.request)) !== JSON.stringify(spec)) throw new Error('spec_conflict');
        if (this.#expired(row)) { await this.#terminate(tx, row); throw new Error('run_fenced'); }
      } else {
        row = { ...identity(spec), request: spec, phase: 'creating', terminal: false,
          creationAttempted: true, containerId: null, createdAt: this.clock() };
        // After this commit, a missing container means UNKNOWN, never safe absence.
        await tx.save(row);
        const created = await this.docker.create(row);
        row.containerId = created.id;
        row.phase = 'created';
        await tx.save(row);
      }
      let found = await this.docker.find(row);
      if (!found) {
        if (!row.containerId) throw new Error('creation_uncertain');
        await this.#terminate(tx, row); throw new Error('run_fenced');
      }
      if (!row.containerId) { row.containerId = found.id; row.phase = 'created'; await tx.save(row); }
      if (['running', 'starting'].includes(row.phase) && !found.running) {
        await this.#terminate(tx, row); throw new Error('run_fenced');
      }
      if (!found.running) {
        row.phase = 'starting'; await tx.save(row);
        await this.docker.start(row);
      }
      found = await this.docker.find(row);
      if (!found?.running) throw new Error('runtime_not_ready');
      await this.docker.ready(row);
      if (this.#expired(row)) { await this.#terminate(tx, row); throw new Error('run_fenced'); }
      row.phase = 'running'; await tx.save(row);
      return this.#dto(row, found);
    });
  }
  async stop(input) {
    const spec = buildStopRequest(input);
    return this.ledger.withRun(spec.runId, async tx => {
      let row = await tx.read();
      if (row) matches(row, spec);
      else row = { ...identity(spec), request: null, creationAttempted: false, containerId: null, createdAt: this.clock() };
      row.fenceGeneration = Math.max(row.fenceGeneration ?? 0, spec.fenceGeneration);
      return this.#terminate(tx, row);
    });
  }
  async inspect(runId) {
    return this.ledger.withRun(runId, async tx => {
      const row = await tx.read();
      if (!row) throw new Error('run_not_found');
      row.checkedAt = this.clock();
      await tx.save(row);
      if (row.terminal || this.#expired(row)) {
        await this.#terminate(tx, row);
        return this.#dto(row);
      }
      const found = await this.docker.find(row);
      if (['running', 'starting'].includes(row.phase) && !found?.running) {
        await this.#terminate(tx, row);
        return this.#dto(row);
      }
      return this.#dto(row, found);
    });
  }
  async reap(limit = 32) {
    const result = { checked: 0, reclaimed: 0, failed: 0 };
    for (const id of await this.ledger.list(limit)) {
      result.checked++;
      try { if (['stopped', 'absent'].includes((await this.inspect(id)).status)) result.reclaimed++; }
      catch { result.failed++; }
    }
    return result;
  }
  #expired(row) { return row.request && this.clock() >= row.createdAt + row.request.resourceSpec.idleTtlSeconds * 1000; }
  #dto(row, found) {
    const status = row.terminal ? row.phase : (row.phase === 'running' && found?.running ? 'running' : 'starting');
    return { ...identity(row), status, observedAt: new Date(this.clock()).toISOString(),
      ...(status === 'running' ? { orchestratorRef: found.id, runtimeUrl: found.runtimeUrl } : {}) };
  }
  async #terminate(tx, row) {
    row.terminal = true;
    row.phase = 'stopping';
    await tx.save(row);
    const found = await this.docker.find(row);
    if (found) {
      row.containerId = found.id;
      await tx.save(row);
      await this.docker.remove(row);
    } else if (row.creationAttempted && !row.containerId) throw new Error('creation_uncertain');
    if (await this.docker.find(row)) throw new Error('removal_unconfirmed');
    row.phase = row.creationAttempted || row.containerId ? 'stopped' : 'absent';
    row.confirmedAt ??= new Date(this.clock()).toISOString();
    await tx.save(row);
    return { ...identity(row), status: row.phase, confirmedAt: row.confirmedAt };
  }
}
