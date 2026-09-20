export type InfraNode = { id: string; name: string; state: string; availability: string; cpuCores: number; memoryBytes: number;
  reservedCpuCores: number; reservedMemoryBytes: number; limitedCpuCores: number; limitedMemoryBytes: number;
  unlimitedCpuTasks: number; unlimitedMemoryTasks: number; activeTasks: number; runningTasks: number; cpuPercent: null; memoryUsedBytes: null };
export type InfraService = { id: string; name: string; mode: string; desiredTasks: number | null; runningTasks: number; pendingTasks: number;
  reservedCpuPerTask: number; reservedMemoryPerTask: number; limitCpuPerTask: number | null; limitMemoryPerTask: number | null };
export type InfraSource = { sourceId: string; label: string; status: 'fresh' | 'stale' | 'waiting' | 'invalid'; sampledAt: string | null; receivedAt: string | null;
  snapshot: null | { version: number; sampledAt: string; host: { platform: string; cpuCount: number; cpuPercent: number | null; memoryTotalBytes: number; memoryUsedBytes: number };
    swarm: { status: string; nodes: InfraNode[]; services: InfraService[]; unassignedTasks: number | null } } };
export type Infrastructure = { items: InfraSource[]; observedAt: string; staleAfterSeconds: number; truncated: boolean };
