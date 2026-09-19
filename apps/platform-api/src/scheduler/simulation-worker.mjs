import { setTimeout as delay } from 'node:timers/promises';

export async function executeSimulation(store, task, { signal } = {}) {
  const end = Date.now() + task.durationMs;
  while (Date.now() < end) {
    try { await delay(Math.min(1000, end - Date.now()), undefined, { signal }); }
    catch (e) { if (e.name === 'AbortError') return false; throw e; }
    if (signal?.aborted || !await store.heartbeat(task)) return false;
  }
  return store.finish(task, task.outcome === 'failure' ? 'failed' : 'succeeded');
}

export async function runSimulationWorker(store, workerId, { signal, onError = console.error } = {}) {
  while (!signal?.aborted) {
    const batch = [];
    try {
      for (let i = 0; i < 5 && !signal?.aborted; i++) {
        const task = await store.claim(workerId);
        if (!task) break;
        batch.push(executeSimulation(store, task, { signal }).catch(e => onError(e)));
      }
    } catch (e) { onError(e); }
    await Promise.all(batch);
    try { await delay(250, undefined, { signal }); }
    catch (e) { if (e.name !== 'AbortError') throw e; }
  }
}
