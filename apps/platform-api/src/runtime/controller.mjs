const SAFE_ERROR_CODE = /^[a-zA-Z0-9_.:-]{1,100}$/;

export function safeRuntimeErrorCode(error) {
  const code = String(error?.code ?? 'runtime_control_error');
  return SAFE_ERROR_CODE.test(code) ? code : 'runtime_control_error';
}

export class RuntimeController {
  constructor({ store, driver, workerId, batchSize = 10, maxAttempts = 8 }) {
    if (!store?.claimCommands || !store?.completeCommand || !store?.reconcileGovernance) {
      throw new TypeError('runtime_control_store_required');
    }
    if (!driver?.provision || !driver?.stop || !driver?.inspect) throw new TypeError('runtime_control_driver_required');
    if (typeof workerId !== 'string' || workerId.length < 1 || workerId.length > 100) throw new TypeError('runtime_controller_id_invalid');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new TypeError('runtime_controller_batch_invalid');
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new TypeError('runtime_controller_attempts_invalid');
    Object.assign(this, { store, driver, workerId, batchSize, maxAttempts });
  }

  async tick() {
    const reconciliation = await this.store.reconcileGovernance({ workerId: this.workerId, limit: this.batchSize });
    const commands = await this.store.claimCommands(this.workerId, this.batchSize);
    const summary = {
      reconciled: Number(reconciliation?.stopped ?? 0),
      claimed: commands.length,
      succeeded: 0,
      retried: 0,
      dead: 0,
    };
    for (const command of commands) {
      const outcome = await this.#handle(command);
      summary[outcome] += 1;
    }
    return summary;
  }

  async #handle(command) {
    if (!['runtime.start.requested', 'runtime.stop.requested'].includes(command.eventType)) {
      await this.store.completeCommand({
        workerId: this.workerId,
        commandId: command.id,
        status: 'dead',
        errorCode: 'runtime_command_unknown',
      });
      return 'dead';
    }
    const spec = { ...command.payload, requestId: command.requestId };
    try {
      if (command.eventType === 'runtime.start.requested') {
        const result = await this.driver.provision(spec);
        await this.store.commitStarted({ workerId: this.workerId, requestId: command.requestId, ...command.payload, ...result });
      } else {
        const result = await this.driver.stop(spec);
        await this.store.commitStopped({ workerId: this.workerId, requestId: command.requestId, ...command.payload, ...result });
      }
      await this.#complete(command, 'succeeded');
      return 'succeeded';
    } catch (error) {
      let failure = error;
      if (error?.code === 'orchestrator_result_unknown') {
        try {
          const observed = await this.driver.inspect(spec);
          if (await this.#commitObserved(command, observed)) {
            await this.#complete(command, 'succeeded');
            return 'succeeded';
          }
        } catch (inspectionError) {
          failure = inspectionError;
        }
      }
      const exhausted = command.attempts >= this.maxAttempts;
      await this.#complete(command, exhausted ? 'dead' : 'failed', safeRuntimeErrorCode(failure));
      return exhausted ? 'dead' : 'retried';
    }
  }

  async #commitObserved(command, observed) {
    if (command.eventType === 'runtime.start.requested' && observed.status === 'running') {
      await this.store.commitStarted({
        workerId: this.workerId,
        requestId: command.requestId,
        ...command.payload,
        ...observed,
      });
      return true;
    }
    if (command.eventType === 'runtime.stop.requested' && ['stopped', 'absent'].includes(observed.status)) {
      await this.store.commitStopped({
        workerId: this.workerId,
        requestId: command.requestId,
        ...command.payload,
        ...observed,
        confirmedAt: observed.confirmedAt ?? observed.observedAt,
      });
      return true;
    }
    return false;
  }

  async #complete(command, status, errorCode = null) {
    const completed = await this.store.completeCommand({
      workerId: this.workerId,
      commandId: command.id,
      status,
      errorCode,
    });
    if (!completed) throw new Error('runtime_command_lease_lost');
  }
}

export default RuntimeController;
