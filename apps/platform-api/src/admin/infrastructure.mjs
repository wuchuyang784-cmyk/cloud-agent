const fail = () => { throw new Error('invalid_infrastructure_snapshot'); };
const number = (value, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : fail();
const integer = (value, max) => Number.isSafeInteger(value) ? number(value, max) : fail();
const text = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : fail();
const choice = (value, values) => values.includes(value) ? value : fail();
const list = (value, max, project) => Array.isArray(value) && value.length <= max ? value.map(project) : fail();
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fail();
const optional = (value, check) => value === null ? null : check(value);

// Rebuild the public contract; stored JSON is never forwarded verbatim.
export function normalizeSnapshot(input) {
  if (input?.version !== 1) fail();
  const h = input.host;
  const host = { platform: choice(h?.platform, ['win32', 'linux', 'darwin']), cpuCount: integer(h.cpuCount, 65536),
    cpuPercent: optional(h.cpuPercent, n => number(n, 100)), memoryTotalBytes: integer(h.memoryTotalBytes), memoryUsedBytes: integer(h.memoryUsedBytes) };
  if (!host.cpuCount || !host.memoryTotalBytes || host.memoryUsedBytes > host.memoryTotalBytes) fail();
  const status = choice(input.swarm?.status, ['ok', 'disabled', 'unavailable', 'unsupported']);
  let swarm = { status, nodes: [], services: [], unassignedTasks: null };
  if (status === 'ok') {
    swarm = { status, unassignedTasks: integer(input.swarm.unassignedTasks, 2048),
      nodes: list(input.swarm.nodes, 32, n => ({ id: text(n.id), name: text(n.name),
        state: choice(n.state, ['unknown', 'down', 'ready', 'disconnected']), availability: choice(n.availability, ['active', 'pause', 'drain']),
        cpuCores: number(n.cpuCores, 65536), memoryBytes: integer(n.memoryBytes),
        reservedCpuCores: number(n.reservedCpuCores), reservedMemoryBytes: integer(n.reservedMemoryBytes),
        limitedCpuCores: number(n.limitedCpuCores), limitedMemoryBytes: integer(n.limitedMemoryBytes),
        unlimitedCpuTasks: integer(n.unlimitedCpuTasks, 2048), unlimitedMemoryTasks: integer(n.unlimitedMemoryTasks, 2048),
        activeTasks: integer(n.activeTasks, 2048), runningTasks: integer(n.runningTasks, 2048), cpuPercent: null, memoryUsedBytes: null })),
      services: list(input.swarm.services, 128, s => ({ id: text(s.id), name: text(s.name), mode: choice(s.mode, ['replicated', 'global', 'job']),
        desiredTasks: optional(s.desiredTasks, n => integer(n, 100000)), runningTasks: integer(s.runningTasks, 2048), pendingTasks: integer(s.pendingTasks, 2048),
        reservedCpuPerTask: number(s.reservedCpuPerTask), reservedMemoryPerTask: integer(s.reservedMemoryPerTask),
        limitCpuPerTask: optional(s.limitCpuPerTask, number), limitMemoryPerTask: optional(s.limitMemoryPerTask, integer) })) };
    if (new Set(swarm.nodes.map(n => n.id)).size !== swarm.nodes.length || new Set(swarm.services.map(s => s.id)).size !== swarm.services.length) fail();
  }
  return { version: 1, sampledAt: date(input.sampledAt), host, swarm };
}

export function projectInfrastructure(raw, now = Date.now()) {
  return { observedAt: new Date(now).toISOString(), staleAfterSeconds: 90, truncated: raw.truncated === true,
    items: list(raw.items, 20, source => {
      const item = { sourceId: text(source.sourceId, 80), label: text(source.label, 100), status: 'waiting', sampledAt: null, receivedAt: null, snapshot: null };
      if (source.payload == null) return item;
      try {
        const snapshot = normalizeSnapshot(source.payload);
        const sampledAt = date(source.sampledAt), receivedAt = date(source.receivedAt);
        if (sampledAt !== snapshot.sampledAt || Date.parse(sampledAt) > now + 10000 || Date.parse(receivedAt) > now + 10000) fail();
        return { ...item, snapshot, sampledAt, receivedAt, status: now - Math.min(Date.parse(sampledAt), Date.parse(receivedAt)) > 90000 ? 'stale' : 'fresh' };
      } catch { return { ...item, status: 'invalid' }; }
    }) };
}
