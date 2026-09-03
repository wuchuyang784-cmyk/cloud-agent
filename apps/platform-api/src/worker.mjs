import { agentHost } from './agent-host.mjs';

export async function provisionPendingAgents({ store, runtime, intervalMs = 1000, signal, workerId = 'platform-worker' }) {
  const tick = async () => {
    if (store.claimOutbox) {
      const items = await store.claimOutbox(workerId, 10);
      for (const item of items) {
        try {
          const payload = item.payload ?? {};
          const agent = { id: item.aggregate_id, organizationId: item.organization_id, host: agentHost(item.aggregate_id) };
          const result = await runtime.provision(agent);
          await store.markAgentReady(agent.id, result.runtimeUrl, { organizationId: item.organization_id, userId: payload.userId });
          await store.completeOutbox(item.id, workerId, 'succeeded');
        } catch (error) {
          await store.completeOutbox(item.id, workerId, 'failed', error.message);
        }
      }
      return;
    }

    for (const item of store.outbox.filter((entry) => entry.status === 'pending')) {
      item.status = 'leased';
      try {
        const agent = store.agents.get(item.aggregateId);
        if (!agent) throw new Error('agent_not_found');
        const result = await runtime.provision(agent);
        store.markAgentReady(agent.id, result.runtimeUrl);
        item.status = 'succeeded';
      } catch (error) {
        item.status = 'failed';
        item.lastError = error.message;
      }
    }
  };

  while (!signal?.aborted) {
    await tick();
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
    });
  }
}
