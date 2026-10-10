const SAFE_ERROR_CODES = new Set([
  'orchestrator_bad_response', 'orchestrator_rejected', 'orchestrator_response_too_large',
  'orchestrator_result_unknown', 'remote_driver_unavailable', 'runtime_url_forbidden', 'stop_not_confirmed',
  'orchestrator_identity_conflict', 'runtime_command_lease_lost', 'runtime_receipt_mismatch',
  'runtime_control_busy', 'runtime_control_timeout', 'runtime_control_unavailable',
  'runtime_control_invalid', 'runtime_control_forbidden', 'runtime_control_conflict', 'runtime_control_reference_invalid',
  'control_body_invalid', 'control_key_id_invalid', 'control_key_unknown', 'control_method_invalid',
  'control_nonce_invalid', 'control_nonce_replayed', 'control_nonce_store_invalid', 'control_path_invalid',
  'control_request_id_invalid', 'control_response_mismatch', 'control_secret_invalid',
  'control_signature_expired', 'control_signature_invalid', 'control_status_invalid',
  'control_timestamp_invalid', 'control_version_invalid',
]);

export function safeRuntimeErrorCode(error) {
  const code = String(error?.code ?? 'runtime_control_error');
  return SAFE_ERROR_CODES.has(code) ? code : 'runtime_control_error';
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

  async tick({ shouldContinue = () => true } = {}) {
    if (!shouldContinue()) return { reconciled: 0, claimed: 0, succeeded: 0, retried: 0, dead: 0 };
    const reconciliation = await this.store.reconcileGovernance({ workerId: this.workerId, limit: this.batchSize });
    const summary = {
      reconciled: Number(reconciliation?.stopped ?? 0),
      claimed: 0,
      succeeded: 0,
      retried: 0,
      dead: 0,
    };
    // Claim only when ready to execute; a slow predecessor must not consume another command's lease.
    for (let index = 0; index < this.batchSize; index += 1) {
      if (!shouldContinue()) break;
      const [command] = await this.store.claimCommands(this.workerId, 1);
      if (!command) break;
      summary.claimed += 1;
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
        leaseAttempt: command.attempts,
        status: 'dead',
        errorCode: 'runtime_command_unknown',
      });
      return 'dead';
    }
    const spec = { ...command.payload, requestId: command.requestId };
    if (command.attempts > this.maxAttempts) {
      await this.#complete(command, 'dead', 'runtime_attempts_exhausted');
      return 'dead';
    }
    try {
      const prepared = await this.store.prepareCommand({ workerId: this.workerId, requestId: command.requestId, leaseAttempt: command.attempts });
      if (!prepared.eligible) {
        await this.#complete(command, 'succeeded');
        return 'succeeded';
      }
      if (command.eventType === 'runtime.start.requested') {
        const result = await this.driver.provision(spec);
        await this.store.commitStarted({ ...command.payload, ...result, workerId: this.workerId, requestId: command.requestId, leaseAttempt: command.attempts });
      } else {
        const result = await this.driver.stop(spec);
        await this.store.commitStopped({ ...command.payload, ...result, workerId: this.workerId, requestId: command.requestId, leaseAttempt: command.attempts });
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
        leaseAttempt: command.attempts,
      });
      return true;
    }
    if (command.eventType === 'runtime.stop.requested' && ['stopped', 'absent'].includes(observed.status)) {
      await this.store.commitStopped({
        workerId: this.workerId,
        requestId: command.requestId,
        ...command.payload,
        ...observed,
        leaseAttempt: command.attempts,
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
      leaseAttempt: command.attempts,
      status,
      errorCode,
    });
    if (!completed) throw new Error('runtime_command_lease_lost');
  }
}

export default RuntimeController;
