import test from 'node:test';
import assert from 'node:assert/strict';
import { monitoringAssets, monitoringRevision, monitorConfigName } from './monitoring-config.mjs';
let api = {};
try { api = await import('./host-monitoring-config.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const input = { installation: 'a'.repeat(24), revision: 'b'.repeat(16), sourcePath: 'E:/cloud-agent/apps/platform-api/src/observability/host-metrics-bridge.mjs' };
test('M1 isolated host resources use official pinned exporter, fixed private bridge and no Docker socket', () => {
  assert.equal(typeof api.hostContainerArgs, 'function');
  const result = api.hostContainerArgs(input);
  for (const [kind, args] of Object.entries(result)) {
    assert.ok(args.includes('--read-only')); assert.ok(args.includes('--cap-drop=ALL')); assert.ok(args.includes('--security-opt=no-new-privileges:true'));
    assert.ok(!args.includes('-p') && !args.includes('--publish')); assert.ok(!args.join(' ').includes('docker.sock'));
    assert.ok(args.includes('--restart=unless-stopped')); assert.ok(args.includes('--pids-limit=64')); assert.ok(args.includes('--init'));
    if (kind === 'exporter') { assert.ok(args.includes('--network=host')); assert.ok(args.includes('--pid=host')); assert.ok(args.includes('--web.listen-address=127.0.0.1:19100')); assert.match(args.join(' '), /prom\/node-exporter:v1\.10\.2@sha256:[a-f0-9]{64}/); }
    if (kind === 'sampler') { assert.ok(args.includes('--network=host')); assert.ok(!args.includes('--pid=host')); }
    if (kind === 'bridge') { assert.ok(args.includes('--network=bairui-preprod-monitor')); assert.ok(args.includes('--network-alias=bairui-host-metrics')); assert.match(args.join(' '), /target=\/data,readonly/); }
  }
});
test('M1 Prometheus target is fixed, bounded and absent unless explicitly enabled', () => {
  assert.equal(typeof api.hostScrapeJob, 'function'); const job = api.hostScrapeJob();
  assert.equal(job.job_name, 'bairui-host'); assert.deepEqual(job.static_configs[0].targets, ['bairui-host-metrics:9100']);
  assert.equal(job.sample_limit, 5000); assert.equal(job.body_size_limit, '512KB');
});
test('host opt-in affects generated monitoring revision and every config reference without enabling by default', () => {
  assert.ok(!monitoringAssets()['prometheus.json'].scrape_configs.some(job => job.job_name === 'bairui-host'));
  const enabled = { enabled: true };
  const job = monitoringAssets(undefined, enabled)['prometheus.json'].scrape_configs.find(job => job.job_name === 'bairui-host');
  assert.ok(job, 'host job is explicit opt-in');
  assert.notEqual(monitoringRevision(undefined, enabled), monitoringRevision());
  assert.notEqual(monitorConfigName('prometheus.json', undefined, enabled), monitorConfigName('prometheus.json'));
  assert.throws(() => monitoringAssets(undefined, { enabled: 'true' }));
});
test('host configuration rejects ownership, image and mount injection', () => {
  for (const field of ['installation', 'revision', 'sourcePath']) assert.throws(() => api.hostContainerArgs({ ...input, [field]: 'bad,source=/etc/passwd\n' }));
});
test('native managed deployment rejects Docker Desktop, non-Linux and remote Docker', () => {
  assert.equal(typeof api.assertNativeHost, 'function');
  assert.doesNotThrow(() => api.assertNativeHost('linux', { OSType: 'linux', OperatingSystem: 'Ubuntu 24.04', Name: 'vm-native' }));
  for (const [platform, info] of [['win32', { OSType: 'linux' }], ['linux', { OSType: 'linux', OperatingSystem: 'Docker Desktop' }], ['linux', { OSType: 'windows' }]]) assert.throws(() => api.assertNativeHost(platform, info));
});
test('host release identity changes for source or image changes, while unchanged releases remain stable', () => {
  assert.equal(typeof api.hostReleaseRevision, 'function');
  const before = api.hostReleaseRevision(input, 'source-v1');
  assert.match(before, /^[a-f0-9]{64}$/); assert.equal(api.hostReleaseRevision(input, 'source-v1'), before);
  assert.notEqual(api.hostReleaseRevision(input, 'source-v2'), before);
  assert.notEqual(api.hostReleaseRevision({ ...input, revision: 'c'.repeat(16) }, 'source-v1'), before);
  for (const args of Object.values(api.hostContainerArgs({ ...input, release: before }))) assert.ok(args.includes('bairui.monitoring.host.revision=' + before));
});
test('host cache reset runs as the data owner rather than root with only CHOWN capability', () => {
  assert.equal(typeof api.hostCacheInitializationArgs, 'function');
  const [owner, reset] = api.hostCacheInitializationArgs(input);
  assert.ok(owner.includes('--user=0:0')); assert.ok(owner.includes('--cap-add=CHOWN')); assert.ok(!owner.at(-1).includes('unlink'));
  assert.ok(reset.includes('--user=1000:1000')); assert.ok(!reset.some(arg => arg.startsWith('--cap-add'))); assert.match(reset.at(-1), /unlinkSync/);
});

test('native kernel and root propagation preflight rejects unsupported recursive readonly hosts', () => {
  assert.equal(typeof api.assertHostMountPrerequisites, 'function');
  const root = '23 1 8:1 / / rw,relatime shared:1 - ext4 /dev/vda2 rw\n';
  assert.doesNotThrow(() => api.assertHostMountPrerequisites('6.8.0-49-generic', root));
  assert.doesNotThrow(() => api.assertHostMountPrerequisites('5.12.0', root.replace('shared:1', 'master:1')));
  for (const version of ['5.11.20', '4.19.0', 'unknown']) assert.throws(() => api.assertHostMountPrerequisites(version, root));
  assert.throws(() => api.assertHostMountPrerequisites('6.8.0', root.replace('shared:1 ', '')));
});

test('actual exporter mountinfo must contain a recursively readonly /host subtree', () => {
  assert.equal(typeof api.assertHostRootReadonly, 'function');
  const valid = '23 1 8:1 / /host ro,relatime - ext4 /dev/vda2 rw\n24 23 8:2 / /host/data\\040files ro - ext4 /dev/vdb rw\n25 1 0:1 / /proc rw - proc proc rw\n';
  assert.doesNotThrow(() => api.assertHostRootReadonly(valid));
  for (const value of ['', valid.replace('/host ro,', '/host rw,'), valid.replace('/host/data\\040files ro', '/host/data\\040files rw'), valid.replace('/host ', '/host-other ')]) {
    assert.throws(() => api.assertHostRootReadonly(value));
  }
});
