import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { normalizeSnapshot } from '../apps/platform-api/src/admin/infrastructure.mjs';

const exec = promisify(execFile);
const terminal = new Set(['complete', 'shutdown', 'failed', 'rejected', 'remove', 'orphaned']);
const activeStates = new Set(['new', 'allocated', 'pending', 'assigned', 'accepted', 'preparing', 'ready', 'starting', 'running']);
const bounded = (rows, max) => { if (!Array.isArray(rows) || rows.length > max) throw new Error('collection_limit'); return rows; };
const resource = r => ({ reservedCpuPerTask: (r?.Reservations?.NanoCPUs ?? 0) / 1e9, reservedMemoryPerTask: r?.Reservations?.MemoryBytes ?? 0,
  limitCpuPerTask: r?.Limits?.NanoCPUs ? r.Limits.NanoCPUs / 1e9 : null, limitMemoryPerTask: r?.Limits?.MemoryBytes || null });

export function hostSample(previous, current, total, free, platform) {
  let cpuPercent = null;
  if (previous?.length === current.length && current.length) {
    const totals = rows => rows.reduce((sum, c) => ({ idle: sum.idle + c.times.idle,
      total: sum.total + Object.values(c.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
    const before = totals(previous), after = totals(current);
    const elapsed = after.total - before.total, idle = after.idle - before.idle;
    if (elapsed > 0 && idle >= 0 && idle <= elapsed) cpuPercent = Math.round((1 - idle / elapsed) * 10000) / 100;
  }
  return { platform, cpuCount: current.length, cpuPercent, memoryTotalBytes: total, memoryUsedBytes: total - free };
}

export function summarizeSwarm(nodes, services, tasks) {
  bounded(nodes, 32); bounded(services, 128); bounded(tasks, 2048);
  if (new Set(tasks.map(t => t.ID)).size !== tasks.length) throw new Error('duplicate_task');
  for (const t of tasks) if (!terminal.has(t.Status?.State) && !activeStates.has(t.Status?.State)) throw new Error('unknown_task_state');
  const active = tasks.filter(t => activeStates.has(t.Status?.State));
  if (active.some(t => t.NodeID && !nodes.some(n => n.ID === t.NodeID))) throw new Error('inconsistent_nodes');
  return { status: 'ok', unassignedTasks: active.filter(t => !t.NodeID).length,
    nodes: nodes.map(node => {
      const placed = active.filter(t => t.NodeID === node.ID), allocations = placed.map(t => resource(t.Spec?.Resources));
      return { id: node.ID, name: node.Description.Hostname, state: node.Status.State, availability: node.Spec.Availability,
        cpuCores: node.Description.Resources.NanoCPUs / 1e9, memoryBytes: node.Description.Resources.MemoryBytes,
        reservedCpuCores: allocations.reduce((sum, r) => sum + r.reservedCpuPerTask, 0),
        reservedMemoryBytes: allocations.reduce((sum, r) => sum + r.reservedMemoryPerTask, 0),
        limitedCpuCores: allocations.reduce((sum, r) => sum + (r.limitCpuPerTask ?? 0), 0),
        limitedMemoryBytes: allocations.reduce((sum, r) => sum + (r.limitMemoryPerTask ?? 0), 0),
        unlimitedCpuTasks: allocations.filter(r => r.limitCpuPerTask === null).length,
        unlimitedMemoryTasks: allocations.filter(r => r.limitMemoryPerTask === null).length,
        activeTasks: placed.length, runningTasks: placed.filter(t => t.Status.State === 'running').length,
        cpuPercent: null, memoryUsedBytes: null };
    }),
    services: services.map(service => {
      const own = active.filter(t => t.ServiceID === service.ID), mode = service.Spec.Mode;
      return { id: service.ID, name: service.Spec.Name, mode: mode.Replicated ? 'replicated' : mode.Global ? 'global' : 'job',
        desiredTasks: mode.Replicated?.Replicas ?? null, runningTasks: own.filter(t => t.Status.State === 'running').length,
        pendingTasks: own.filter(t => t.Status.State !== 'running' && t.DesiredState === 'running').length,
        ...resource(service.Spec.TaskTemplate?.Resources) };
    }) };
}

const nodeFormat = '{"ID":{{json .ID}},"Description":{"Hostname":{{json .Description.Hostname}},"Resources":{{json .Description.Resources}}},"Status":{"State":{{json .Status.State}}},"Spec":{"Availability":{{json .Spec.Availability}}}}';
const serviceFormat = '{"ID":{{json .ID}},"Spec":{"Name":{{json .Spec.Name}},"Mode":{{json .Spec.Mode}},"TaskTemplate":{"Resources":{{json .Spec.TaskTemplate.Resources}}}}}';
const taskFormat = '{"ID":{{json .ID}},"NodeID":{{json .NodeID}},"ServiceID":{{json .ServiceID}},"DesiredState":{{json .DesiredState}},"Status":{"State":{{json .Status.State}}},"Spec":{"Resources":{{json .Spec.Resources}}}}';

// Only constant read operations reach the Docker CLI; no shell and no complete service inspect.
export async function collectSwarm({ env = process.env, run = exec } = {}) {
  if (env.BAIRUI_INFRA_SWARM !== '1') return { status: 'disabled', nodes: [], services: [] };
  try {
    const cleanEnv = { ...env };
    delete cleanEnv.DOCKER_HOST; delete cleanEnv.DOCKER_CONTEXT;
    const deadline = Date.now() + 20000;
    const command = async args => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('collection_timeout');
      return (await run('docker', args, { env: cleanEnv, windowsHide: true, timeout: Math.min(5000, remaining), maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
    };
    const context = env.BAIRUI_INFRA_DOCKER_CONTEXT || env.DOCKER_CONTEXT || await command(['context', 'show']);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(context)) throw new Error('invalid_context');
    const endpoint = JSON.parse(await command(['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}']));
    if (env.DOCKER_HOST || typeof endpoint !== 'string' || !/^(unix:\/\/\/|npipe:\/\/\/\/\.\/pipe\/)/.test(endpoint)) throw new Error('local_endpoint_required');
    const docker = args => command(['--context', context, ...args]);
    const ids = (value, max) => {
      const result = value ? value.split(/\s+/) : [];
      if (result.some(id => !/^[a-z0-9]{1,64}$/.test(id))) throw new Error('invalid_docker_id');
      return bounded([...new Set(result)], max);
    };
    const records = async (prefix, names, format) => {
      const result = [];
      for (let i = 0; i < names.length; i += 64) {
        const out = await docker([...prefix, '--format', format, ...names.slice(i, i + 64)]);
        result.push(...out.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
      }
      if (result.length !== names.length) throw new Error('incomplete_inspection');
      return result;
    };
    const nodeIds = ids(await docker(['node', 'ls', '--quiet']), 32);
    if (!nodeIds.length) throw new Error('no_swarm_nodes');
    const serviceIds = ids(await docker(['service', 'ls', '--quiet']), 128);
    const nodes = await records(['node', 'inspect'], nodeIds, nodeFormat);
    const services = await records(['service', 'inspect'], serviceIds, serviceFormat);
    const taskIds = [];
    for (let i = 0; i < serviceIds.length; i += 32) {
      taskIds.push(...ids(await docker(['service', 'ps', '--quiet', '--no-trunc', ...serviceIds.slice(i, i + 32)]), 2048));
      bounded(taskIds, 2048);
    }
    const tasks = await records(['inspect', '--type', 'task'], [...new Set(taskIds)], taskFormat);
    return summarizeSwarm(nodes, services, tasks);
  } catch { return { status: 'unavailable', nodes: [], services: [] }; }
}

export async function collectSnapshot(previous, options = {}) {
  const swarm = await collectSwarm(options);
  const current = os.cpus();
  const snapshot = normalizeSnapshot({ version: 1, sampledAt: new Date().toISOString(),
    host: hostSample(previous, current, os.totalmem(), os.freemem(), os.platform()), swarm });
  return { snapshot, current };
}

export async function runCollector({ env = process.env, once = false, check = false } = {}) {
  let pool;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (!check) {
      if (!env.BAIRUI_INFRA_DATABASE_URL) throw new Error('collector_configuration_required');
      const { Pool } = createRequire(new URL('../apps/platform-api/package.json', import.meta.url))('pg');
      pool = new Pool({ connectionString: env.BAIRUI_INFRA_DATABASE_URL, max: 1, connectionTimeoutMillis: 3000,
        statement_timeout: 3000, query_timeout: 5000, application_name: 'bairui-infrastructure-collector' });
      pool.on('error', () => console.error('采集连接异常；等待下一轮重试。'));
    }
    let previous = os.cpus();
    await sleep(1000, undefined, { signal: abort.signal });
    do {
      try {
        const { snapshot, current } = await collectSnapshot(previous, { env });
        previous = current;
        if (check) console.log(JSON.stringify(snapshot, null, 2));
        else {
          const result = await pool.query('SELECT public.platform_infrastructure_report($1::jsonb) AS accepted', [JSON.stringify(snapshot)]);
          if (!result.rows[0].accepted) throw new Error('snapshot_not_accepted');
          console.log('资源快照已上报；Swarm: ' + snapshot.swarm.status);
        }
      } catch {
        console.error('采集或上报失败；请检查专用账号、035 迁移和本机 Docker。未输出连接串或原始错误。');
        if (once || check) { process.exitCode = 1; break; }
      }
      if (once || check) break;
      await sleep(15000, undefined, { signal: abort.signal });
    } while (!abort.signal.aborted);
  } catch (error) {
    if (!abort.signal.aborted) { console.error('采集器未启动；需要专用 BAIRUI_INFRA_DATABASE_URL 配置。'); process.exitCode = 1; }
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await pool?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCollector({ once: process.argv.includes('--once'), check: process.argv.includes('--check') });
}
