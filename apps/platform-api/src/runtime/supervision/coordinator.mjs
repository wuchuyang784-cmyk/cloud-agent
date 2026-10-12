import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../controller.mjs';

export function createSupervisionCoordinator({ store, driver, workerId, batchSize = 1, maxAttempts = 8, now = Date.now }) {
  const controller = new RuntimeController({ store, driver, workerId, batchSize, maxAttempts });
  return async function cycle(shouldContinue = () => true) {
    await controller.tick({ shouldContinue });
    for (let index = 0; index < batchSize && shouldContinue(); index++) {
      const lease = await store.claimObservation(workerId);
      if (!lease) break;
      let observed;
      try {
        observed = await driver.inspect({ agentId: lease.agentId, runId: lease.runId,
          runGeneration: lease.runGeneration, requestId: randomUUID() });
      } catch {
        // Network, HTTP and signature failures are errors, never evidence of absence.
        observed = { status: 'error', observedAt: new Date(now()).toISOString() };
      }
      try {
        await store.recordObservation({ ...lease, status: observed.status, observedAt: observed.observedAt,
          orchestratorRef: observed.orchestratorRef, runtimeUrl: observed.runtimeUrl });
      } catch (error) {
        if (!['observation_lease_lost', 'observation_superseded', 'runtime_observation_lease_lost', 'runtime_observation_superseded'].includes(error?.code)) throw error;
      }
    }
    return store.supervisionSnapshot();
  };
}
