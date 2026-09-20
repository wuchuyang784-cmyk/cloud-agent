import { agentHost } from './agent-host.mjs';

// Agent provisioning 轮询器：每 tick 领取 pending outbox，按其 agent.engine 解析对应
// 引擎 adapter 并 provision（真实引擎未就绪时由 registry 统一回退 mock）。
export async function provisionPendingAgents({ store, runtime, resolver, intervalMs = 1000, signal, workerId = 'platform-worker' }) {
  // 传入 resolver 时按 agent.engine 动态选择运行时；否则用固定的 runtime（测试/旧路径）。
  const pick = (agent) => (resolver ? resolver.resolve(agent?.engine ?? 'mock').runtime : runtime);

  const tick = async () => {
    if (store.claimOutbox) {
      const items = await store.claimOutbox(workerId, 10);
      for (const item of items) {
        try {
          const payload = item.payload ?? {};
          const agent = { id: item.aggregate_id, organizationId: item.organization_id, engine: payload.engine ?? 'mock', host: agentHost(item.aggregate_id) };
          const result = await pick(agent).provision(agent);
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
        const result = await pick(agent).provision(agent);
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
