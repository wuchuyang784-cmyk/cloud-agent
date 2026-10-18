import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const module = await import('./host-monitoring-native-acceptance.mjs').catch(() => ({}));

test('native acceptance rejects writable recursive host mounts and requires the actual root bind', () => {
  assert.equal(typeof module.checkHostMounts, 'function');
  const root = '1 0 8:1 / /host ro,relatime shared:1 - ext4 /dev/vda1 rw';
  const child = '2 1 0:2 / /host/proc ro,nosuid - proc proc rw';
  assert.equal(module.checkHostMounts(root + '\n' + child).length, 2);
  assert.throws(() => module.checkHostMounts(root + '\n' + child.replace('ro,nosuid', 'rw,nosuid')), /host_metrics_submount_not_readonly/);
  assert.throws(() => module.checkHostMounts(child), /host_metrics_root_mount_missing/);
});

test('native acceptance removes only exact resources bearing its own random owner label', async () => {
  assert.equal(typeof module.removeOwnedResource, 'function');
  const commands = [], owner = 'a'.repeat(24);
  const docker = async args => {
    commands.push(args);
    if (args[0] === 'inspect') return JSON.stringify([{ Id: 'own-id', Config: { Labels: { 'bairui.m1-native.acceptance': owner } } }]);
    return '';
  };
  await module.removeOwnedResource({ type: 'container', name: 'bairui-m1-test', owner, docker });
  assert.deepEqual(commands[1], ['rm', '-f', 'own-id']);
  commands.length = 0;
  await assert.rejects(module.removeOwnedResource({ type: 'container', name: 'existing-service', owner: 'b'.repeat(24), docker }), /acceptance_owner_mismatch/);
  assert.equal(commands.length, 1);
});

test('native cleanup treats an explicitly missing network or volume as already removed but retains permission failures', async () => {
  for (const type of ['network', 'volume']) {
    await module.removeOwnedResource({ type, name: 'bairui-m1-unused', owner: 'a'.repeat(24), docker: async () => { throw new Error(`Error response from daemon: ${type} bairui-m1-unused not found`); } });
  }
  await assert.rejects(module.removeOwnedResource({ type: 'volume', name: 'bairui-m1-unused', owner: 'a'.repeat(24), docker: async () => { throw new Error('permission denied'); } }), /permission denied/);
});

test('native CLI requires explicit destination and API revision before allowing any remote work', () => {
  assert.equal(typeof module.parseNativeAcceptanceArgs, 'function');
  const args = ['--ssh', 'ops@host.example', '--project-root', '/srv/cloud-agent', '--api-revision', 'a'.repeat(16), '--conda-path', '/opt/conda/bin/conda'];
  assert.deepEqual(module.parseNativeAcceptanceArgs(args), { mode: 'ssh', host: 'ops@host.example', projectRoot: '/srv/cloud-agent', apiRevision: 'a'.repeat(16), condaPath: '/opt/conda/bin/conda' });
  assert.deepEqual(module.parseNativeAcceptanceArgs(['--help']), { mode: 'help' });
  for (const bad of [[], ['--ssh'], args.slice(0, 4), args.slice(0, 2), [...args, '--ssh', 'other'], [...args, '--unknown', 'x'], [...args, '--help']]) assert.throws(() => module.parseNativeAcceptanceArgs(bad), /native_acceptance_arguments_invalid/);
  assert.equal(module.parseNativeAcceptanceArgs(args.slice(0, 6)).condaPath, undefined, 'omitting conda path permits only later read-only discovery');
});

test('native CLI rejects shell metacharacters and traversal in host, project path and optional conda path', () => {
  const base = ['--ssh', 'linux-alias', '--project-root', '/srv/cloud-agent', '--api-revision', 'a'.repeat(16)];
  for (const [index, values] of [[1, ['-oProxyCommand=bad', 'host;id', 'u@host$(id)', 'a b', 'a\nb', 'u@host/path']],
    [3, ['relative', '/', '/srv/../etc', '/srv/a..b', '/srv/a;id', '/srv/a b', '/srv/a\n']], [5, ['A'.repeat(16), 'bad', 'a'.repeat(16) + ';id']]]) {
    for (const value of values) { const args = [...base]; args[index] = value; assert.throws(() => module.parseNativeAcceptanceArgs(args), /native_acceptance_arguments_invalid/, value); }
  }
  for (const value of ['conda', '/opt/conda;id', '/opt/../conda', '/opt/a b/conda']) assert.throws(() => module.parseNativeAcceptanceArgs([...base, '--conda-path', value]), /native_acceptance_arguments_invalid/);
});

test('remote command uses explicit Conda cloud environment and passes the same revision to the isolated runner', () => {
  assert.equal(typeof module.nativeRemoteCommand, 'function');
  const input = { condaPath: '/opt/conda/bin/conda', scriptPath: '/srv/cloud-agent/output/m1-native/run/source/scripts/host-monitoring-native-acceptance.mjs',
    output: '/srv/cloud-agent/output/m1-native/run/report.json', owner: 'b'.repeat(24), apiRevision: 'a'.repeat(16) };
  assert.equal(module.nativeRemoteCommand(input), `${input.condaPath} run -n cloud --no-capture-output node ${input.scriptPath} --run-linux --owner ${input.owner} --output ${input.output} --api-revision ${input.apiRevision}`);
  for (const [key, value] of [['condaPath', '/opt/conda;id'], ['scriptPath', '/tmp/../runner'], ['output', '/tmp/report;id'], ['owner', 'x'], ['apiRevision', 'b'.repeat(16) + ';id']]) assert.throws(() => module.nativeRemoteCommand({ ...input, [key]: value }), /native_acceptance_arguments_invalid/);
  assert.deepEqual(module.parseNativeAcceptanceArgs(['--run-linux', '--owner', input.owner, '--output', input.output, '--api-revision', input.apiRevision]), { mode: 'linux', owner: input.owner, output: input.output, apiRevision: input.apiRevision });
  assert.throws(() => module.parseNativeAcceptanceArgs(['--run-linux', '--owner', input.owner, '--output', input.output]), /native_acceptance_arguments_invalid/);
});

test('native preflight accepts any existing container count while retaining exact baseline identity checks', async () => {
  const source = await readFile(new URL('./host-monitoring-native-acceptance.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /expected_eight_existing_running_containers|assert\.equal\(existing\.length,\s*8\b/);
  assert.match(source, /assert\.deepEqual\(after, existing, 'existing_running_container_IDs_changed'\)/);
  assert.doesNotMatch(source, /150\.158\.44\.104|\/home\/ubuntu\/cloud-agent|15332ba0c8b4297a/);
});

test('direct native runner validates API revision before any platform or Docker operation', async () => {
  for (const value of [undefined, 'bad', 'A'.repeat(16), 'a'.repeat(16) + ';id']) {
    await assert.rejects(module.runNative({ owner: 'a'.repeat(24), output: '/tmp/native-report.json', apiRevision: value }), /native_acceptance_arguments_invalid/);
  }
});
