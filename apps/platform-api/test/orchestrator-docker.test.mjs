import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerOrchestratorDriver, containerName, createArguments } from '../src/runtime/orchestrator/docker.mjs';
const options = { installationId: 'test-install-123', network: 'test-net', image: `sha256:${'a'.repeat(64)}` };
const row = { agentId: 'a;docker rm', runId: '../../anything', runGeneration: 1, request: {
  resourceSpec: { cpuMillis: 200, memoryBytes: 134217728, pidsLimit: 32, idleTtlSeconds: 60 },
} };

test('fixed CLI argv enforces resource and security boundaries without request command/env injection', () => {
  const args = createArguments(options, row);
  assert.match(containerName(options.installationId, row.runId), /^br-e2-[a-f0-9]{40}$/);
  for (const arg of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user=1000:1000',
    '--cpus=0.2', '--memory=134217728', '--memory-swap=134217728', '--pids-limit=32', '--restart=no', '--log-driver=none']) assert.ok(args.includes(arg), arg);
  assert.ok(!args.some(arg => /^(--env|--mount|--volume|--publish|--privileged)/.test(arg)));
  assert.ok(!args.join(' ').includes(row.agentId));
  assert.ok(!args.join(' ').includes(row.runId));
});

test('rejects unpinned images, invalid installation and network; unavailable Docker is not absent', async () => {
  assert.throws(() => new DockerOrchestratorDriver({ ...options, image: 'node:latest' }), /config_invalid/);
  assert.throws(() => new DockerOrchestratorDriver({ ...options, installationId: '../bad' }), /config_invalid/);
  const driver = new DockerOrchestratorDriver({ ...options, execute: async () => { throw new Error('socket unavailable'); } });
  await assert.rejects(driver.find(row), /docker_unknown/);
});

test('foreign deterministic-name occupant cannot be adopted or removed', async () => {
  let removed = false;
  const driver = new DockerOrchestratorDriver({ ...options, execute: async args => {
    if (args[0] === 'ps') return 'b'.repeat(64);
    if (args[0] === 'inspect') return JSON.stringify([{ Id: 'b'.repeat(64), Config: { Labels: {} } }]);
    removed = true; return '';
  } });
  await assert.rejects(driver.remove(row), /ownership_mismatch/);
  assert.equal(removed, false);
});

test('network must be internal and installation-owned; image must not declare implicit volumes', async () => {
  const driver = new DockerOrchestratorDriver({ ...options, execute: async args => JSON.stringify(
    args[0] === 'network' ? [{ Internal: false, Labels: {} }] : [{ Id: options.image }]) });
  await assert.rejects(driver.check(), /network_invalid/);
});

test('known container ID is queried even if original name no longer exists', async () => {
  const calls = [];
  const id = 'c'.repeat(64);
  const driver = new DockerOrchestratorDriver({ ...options, execute: async args => { calls.push(args); return ''; } });
  await driver.find({ ...row, containerId: id });
  assert.ok(calls.some(args => args.includes(`id=${id}`)));
});
