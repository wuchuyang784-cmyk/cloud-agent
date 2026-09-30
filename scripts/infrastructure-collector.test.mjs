import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('Linux collector service keeps credentials separate and does not deploy or mutate Swarm', () => {
  const file = new URL('../infra/systemd/bairui-infrastructure.service', import.meta.url);
  assert.equal(existsSync(file), true, 'Linux collector service template must exist');
  const unit = readFileSync(file, 'utf8');
  assert.match(unit, /^User=bairui-infra$/m);
  assert.match(unit, /^LoadCredential=infrastructure.env:\/etc\/bairui\/infrastructure.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node --env-file=\$\{CREDENTIALS_DIRECTORY\}\/infrastructure.env \/opt\/bairui\/cloud-agent\/scripts\/infrastructure-collector.mjs$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^WantedBy=multi-user.target$/m);
  assert.doesNotMatch(unit, /BAIRUI_INFRA_DATABASE_URL=|postgres(?:ql)?:\/\/|ExecStartPre=|docker (?:stack|service|run|swarm)/);
  assert.doesNotMatch(unit, /EnvironmentFile=|--env-file-if-exists|console-mvp|platform-api\/src\/index/);
});

test('host sample uses CPU deltas and keeps a missing initial sample null', async () => {
  const { hostSample } = await import('./infrastructure-collector.mjs');
  const cpu = idle => [{ times: { user: 20, nice: 0, sys: 10, idle, irq: 0 } }];
  assert.equal(hostSample(null, cpu(70), 1000, 400, 'win32').cpuPercent, null);
  assert.equal(hostSample(cpu(70), [{ times: { user: 30, nice: 0, sys: 20, idle: 150, irq: 0 } }], 1000, 400, 'win32').cpuPercent, 20);
  assert.equal(hostSample(cpu(70), cpu(70), 1000, 400, 'win32').cpuPercent, null);
  assert.equal(hostSample(null, cpu(70), 1000, 400, 'win32').memoryUsedBytes, 600);
});

test('Swarm accounting separates capacity, active reservations, limits and unassigned tasks', async () => {
  const { summarizeSwarm } = await import('./infrastructure-collector.mjs');
  const resources = { Reservations: { NanoCPUs: 500000000, MemoryBytes: 100 }, Limits: { NanoCPUs: 2000000000, MemoryBytes: 300 } };
  const nodes = [{ ID: 'node-a', Description: { Hostname: 'linux-vm', Resources: { NanoCPUs: 4000000000, MemoryBytes: 2000 } }, Status: { State: 'ready' }, Spec: { Availability: 'active' } }];
  const services = [{ ID: 'service-a', Spec: { Name: 'api', Mode: { Replicated: { Replicas: 2 } }, TaskTemplate: { Resources: resources } } }];
  const tasks = [
    { ID: 't1', NodeID: 'node-a', ServiceID: 'service-a', DesiredState: 'running', Status: { State: 'running' }, Spec: { Resources: resources } },
    { ID: 't2', NodeID: 'node-a', ServiceID: 'service-a', DesiredState: 'shutdown', Status: { State: 'running' }, Spec: { Resources: resources } },
    { ID: 't3', NodeID: '', ServiceID: 'service-a', DesiredState: 'running', Status: { State: 'pending' }, Spec: { Resources: resources } },
    { ID: 't4', NodeID: 'node-a', ServiceID: 'service-a', DesiredState: 'shutdown', Status: { State: 'complete' }, Spec: { Resources: resources } },
  ];
  const sample = summarizeSwarm(nodes, services, tasks);
  assert.equal(sample.nodes[0].reservedCpuCores, 1);
  assert.equal(sample.nodes[0].reservedMemoryBytes, 200);
  assert.equal(sample.nodes[0].limitedCpuCores, 4);
  assert.equal(sample.nodes[0].cpuPercent, null);
  assert.equal(sample.services[0].pendingTasks, 1);
  assert.equal(sample.services[0].runningTasks, 2);
  assert.equal(sample.services[0].desiredTasks, 2);
  assert.equal(sample.unassignedTasks, 1);
  assert.throws(() => summarizeSwarm(Array(33).fill(nodes[0]), services, tasks));
});

test('snapshot normalization rebuilds selected fields only and rejects out-of-range values', async () => {
  const { normalizeSnapshot } = await import('./infrastructure-snapshot.mjs');
  const payload = { version: 1, sampledAt: new Date().toISOString(),
    host: { platform: 'win32', cpuCount: 4, cpuPercent: 15, memoryTotalBytes: 16000, memoryUsedBytes: 8000, secret: 'never-return' },
    swarm: { status: 'unavailable', nodes: [], services: [], metadata: 'never-return' } };
  const snapshot = normalizeSnapshot(payload);
  assert.deepEqual(snapshot.host, { platform: 'win32', cpuCount: 4, cpuPercent: 15, memoryTotalBytes: 16000, memoryUsedBytes: 8000 });
  assert.equal(JSON.stringify(snapshot).includes('never-return'), false);
  assert.throws(() => normalizeSnapshot({ ...payload, host: { ...payload.host, cpuPercent: 101 } }));
  assert.throws(() => normalizeSnapshot({ ...payload, version: 2 }));
});

test('collector is opt-in, refuses remote endpoints and inherited DOCKER_HOST before contacting a daemon', async () => {
  const { collectSwarm } = await import('./infrastructure-collector.mjs');
  assert.equal((await collectSwarm({ env: {}, run: async () => { throw new Error('must_not_run'); } })).status, 'disabled');
  for (const [endpoint, host] of [['tcp://remote:2376', ''], ['ssh://user@server', ''], ['npipe:////./pipe/dockerDesktopLinuxEngine', 'tcp://remote:2376']]) {
    const calls = [];
    const result = await collectSwarm({ env: { BAIRUI_INFRA_SWARM: '1', BAIRUI_INFRA_DOCKER_CONTEXT: 'desktop-linux', DOCKER_HOST: host },
      run: async (_file, args, options) => {
        calls.push(args);
        assert.equal(options.env.DOCKER_HOST, undefined);
        assert.ok(options.timeout > 0 && options.timeout <= 5000);
        assert.ok(options.maxBuffer <= 2 * 1024 * 1024);
        return { stdout: JSON.stringify(endpoint) };
      } });
    assert.equal(result.status, 'unavailable');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ['context', 'inspect']);
  }
});

test('collector uses selected fields only and never leaks CLI errors or partially collected node lists', async () => {
  const { collectSwarm } = await import('./infrastructure-collector.mjs');
  const calls = [];
  const result = await collectSwarm({ env: { BAIRUI_INFRA_SWARM: '1', BAIRUI_INFRA_DOCKER_CONTEXT: 'local' },
    run: async (_file, args) => {
      calls.push(args);
      if (args[0] === 'context') return { stdout: JSON.stringify('unix:///var/run/docker.sock') };
      if (args.includes('ls')) return { stdout: args.includes('node') ? 'node1' : 'service1' };
      if (args.includes('node')) return { stdout: JSON.stringify({ ID: 'node1' }) };
      throw new Error('sensitive-cli-connection-and-secrets');
    } });
  assert.deepEqual(result, { status: 'unavailable', nodes: [], services: [] });
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
  const inspection = calls.find(args => args.includes('service') && args.includes('inspect'));
  assert.ok(inspection.includes('--format'));
  assert.equal(inspection.join(' ').includes('{{json .}}'), false);
  assert.equal(inspection.join(' ').includes('ContainerSpec'), false);
});

test('snapshot validation rejects negative usage, over-capacity memory and excessive cardinality', async () => {
  const { normalizeSnapshot } = await import('./infrastructure-snapshot.mjs');
  const sample = { version: 1, sampledAt: new Date().toISOString(), host: { platform: 'win32', cpuCount: 4, cpuPercent: null, memoryTotalBytes: 16000, memoryUsedBytes: 8000 }, swarm: { status: 'disabled' } };
  assert.throws(() => normalizeSnapshot({ ...sample, host: { ...sample.host, memoryUsedBytes: -1 } }));
  assert.throws(() => normalizeSnapshot({ ...sample, host: { ...sample.host, memoryUsedBytes: 16001 } }));
  const node = { id: 'node-a', name: 'linux-vm', state: 'ready', availability: 'active', cpuCores: 4, memoryBytes: 2000, reservedCpuCores: 1,
    reservedMemoryBytes: 100, limitedCpuCores: 2, limitedMemoryBytes: 200, unlimitedCpuTasks: 0, unlimitedMemoryTasks: 0, activeTasks: 1, runningTasks: 1 };
  const swarm = { status: 'ok', unassignedTasks: 0, nodes: [node], services: [] };
  assert.throws(() => normalizeSnapshot({ ...sample, swarm: { ...swarm, nodes: Array(33).fill(node) } }));
  assert.throws(() => normalizeSnapshot({ ...sample, swarm: { ...swarm, nodes: [node, { ...node, name: 'duplicate' }] } }));
  assert.equal(normalizeSnapshot({ ...sample, swarm }).swarm.nodes[0].cpuPercent, null);
});
