import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

const MiB = 1024 ** 2;
function fixture() {
  return {
    schemaVersion: 1, installationId: 'install-test-01',
    identity: {
      organizationId: 'org-a', ownerUserId: 'owner-a', agentId: 'agent-a',
      runId: 'run-11111111-1111-4111-8111-111111111111', runGeneration: 1,
      sessionId: '22222222-2222-4222-8222-222222222222',
    },
    sandboxImage: `sha256:${'a'.repeat(64)}`, controlImage: `sha256:${'b'.repeat(64)}`,
    runtime: 'runsc', storageRoot: '/srv/bairui/agents',
    gatewayUrl: 'https://model-gateway.internal:8443/v1/chat/completions', model: 'bound-model',
    resources: { cpuMillis: 500, memoryBytes: 256 * MiB, pidsLimit: 64,
      tmpfsBytes: 16 * MiB, workspaceBytes: 1024 * MiB, workspaceInodes: 4096 },
  };
}
async function validator() {
  try { return (await import('../src/runtime/pi/sandbox/profile.mjs')).validateSandboxProfile; }
  catch (error) { assert.fail(`Profile validation feature missing: ${error.code}`); }
}
async function compiler() {
  try { return (await import('../src/runtime/pi/sandbox/policy.mjs')).compileSandboxPolicy; }
  catch (error) { assert.fail(`Sandbox policy feature missing: ${error.code}`); }
}
function assertFrozen(value) {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertFrozen(child);
  }
}

test('validates and deeply clones/freezes the trusted machine profile without normalizing identity', async () => {
  const validate = await validator();
  const input = fixture();
  input.identity.runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const profile = validate(input);
  assert.deepEqual(profile, input);
  assert.notEqual(profile, input);
  assert.notEqual(profile.identity, input.identity);
  input.identity.ownerUserId = 'other-owner';
  input.resources.cpuMillis = 1000;
  assert.equal(profile.identity.ownerUserId, 'owner-a');
  assert.equal(profile.resources.cpuMillis, 500);
  assertFrozen(profile);
});

test('rejects unknown fields including arbitrary commands, environment, networking and volumes', async () => {
  const validate = await validator();
  for (const key of ['env', 'args', 'command', 'network', 'networks', 'volumes', 'profileRevision', 'token']) {
    assert.throws(() => validate({ ...fixture(), [key]: 'PRIVATE-CANARY' }), /Invalid sandbox profile/);
  }
  for (const section of ['identity', 'resources']) {
    const value = fixture(); value[section].unknown = true;
    assert.throws(() => validate(value));
  }
  for (const key of Object.keys(fixture())) {
    const value = fixture(); delete value[key];
    assert.throws(() => validate(value));
  }
});

test('rejects invalid or missing run identity and generation values', async () => {
  const validate = await validator();
  for (const [key, values] of Object.entries({
    organizationId: ['', '../org', 'a'.repeat(129)], ownerUserId: ['', 'owner/a'],
    agentId: ['', 'agent\\a'], runId: ['run-a', 'run-../../escape', 123],
    runGeneration: [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'], sessionId: ['session-a', null],
  })) {
    for (const invalid of values) {
      const value = fixture(); value.identity[key] = invalid;
      assert.throws(() => validate(value), `${key}: ${invalid}`);
    }
  }
});

test('rejects invalid installation identifiers, mutable image references and runtime fallback', async () => {
  const validate = await validator();
  for (const [key, values] of Object.entries({
    schemaVersion: [0, 2, '1'], installationId: ['short', '../install', 'x'.repeat(49)],
    sandboxImage: ['bairui/pi:latest', 'sha256:abcd', `sha256:${'z'.repeat(64)}`],
    controlImage: ['control:1', `name@sha256:${'a'.repeat(64)}`], runtime: ['runc', '', null],
  })) for (const invalid of values) assert.throws(() => validate({ ...fixture(), [key]: invalid }));
});

test('rejects noncanonical storage roots and path traversal', async () => {
  const validate = await validator();
  for (const storageRoot of ['/', '', 'relative', 'C:\\storage', '/srv/../other', '/srv/./data',
    '/srv//data', '//srv/data', '/srv/data/', '/srv,data', '/srv/\nprivate', '/srv/\\other', '/srv/%2e%2e']) {
    assert.throws(() => validate({ ...fixture(), storageRoot }), storageRoot);
  }
});

test('only accepts fixed bounded HTTPS gateway URLs and safe model identifiers', async () => {
  const validate = await validator();
  for (const gatewayUrl of ['http://gateway.internal/v1', 'https://user:pass@gateway.internal/v1',
    'https://gateway.internal/v1?token=PRIVATE-CANARY', 'https://gateway.internal/v1#fragment',
    'https://gateway.internal/a/../v1', 'https://gateway.internal//v1',
    'https://gateway.internal/%2e%2e/v1', 'https://gateway.internal/\\evil',
    'https://gateway.internal', 'https://gateway.internal/', 'https://gateway.internal/other',
    'https://gateway.internal/v2', 'https://gateway.internal/v1/models',
    'https://gateway.internal/v1/chat/completions/',
    'https://%67ateway.internal/v1',
    `https://gateway.internal/${'a'.repeat(513)}`, 'https://gateway.internal/\nv1']) {
    assert.throws(() => validate({ ...fixture(), gatewayUrl }), gatewayUrl);
  }
  for (const model of ['', 'a'.repeat(129), '../model', 'model\nother']) {
    assert.throws(() => validate({ ...fixture(), model }));
  }
});

test('only accepts the three fixed F2 gateway endpoint spellings without rewriting them', async () => {
  const validate = await validator();
  for (const endpoint of ['/v1', '/v1/', '/v1/chat/completions']) {
    const gatewayUrl = `https://gateway.internal:8443${endpoint}`;
    assert.equal(validate({ ...fixture(), gatewayUrl }).gatewayUrl, gatewayUrl);
  }
});

test('every accepted gateway URL compiles into configuration the real model proxy accepts', async () => {
  const validate = await validator();
  const compile = await compiler();
  const { createSandboxModelProxy } = await import('../src/runtime/pi/sandbox/model-proxy.mjs');
  const token = Buffer.alloc(32, 7).toString('base64url');
  const candidates = ['', '/', '/other', '/v1', '/v1/', '/v1/chat/completions', '/v1/models']
    .map(endpoint => `https://gateway.internal${endpoint}`);
  candidates.push('https://%67ateway.internal/v1');
  let accepted = 0;
  for (const gatewayUrl of candidates) {
    let profile;
    try { profile = validate({ ...fixture(), gatewayUrl }); }
    catch (error) { assert.equal(error.code, 'SANDBOX_PROFILE_INVALID'); continue; }
    const policy = compile(profile);
    const proxy = createSandboxModelProxy({ gatewayUrl: policy.control.gatewayUrl, model: policy.control.model, token });
    try { assert.equal(proxy.server.listening, false); }
    finally { await proxy.close(); }
    accepted += 1;
  }
  assert.equal(accepted, 3);
});

test('enforces every resource integer and inclusive hard bounds', async () => {
  const validate = await validator();
  const bounds = { cpuMillis: [100, 2000], memoryBytes: [128 * MiB, 4096 * MiB],
    pidsLimit: [16, 256], tmpfsBytes: [MiB, 64 * MiB],
    workspaceBytes: [16 * MiB, 10 * 1024 * MiB], workspaceInodes: [128, 100000] };
  for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
    for (const invalid of [minimum - 1, maximum + 1, -1, 0, 1.5, NaN, Infinity, '500', Number.MAX_SAFE_INTEGER + 1]) {
      const value = fixture(); value.resources[key] = invalid;
      assert.throws(() => validate(value), key);
    }
    for (const accepted of [minimum, maximum]) {
      const value = fixture(); value.resources[key] = accepted;
      assert.equal(validate(value).resources[key], accepted);
    }
  }
});

test('rejects exotic prototypes, symbols, accessors and private error leakage', async () => {
  const validate = await validator();
  let getterCalled = false;
  const accessor = fixture();
  Object.defineProperty(accessor, 'model', { enumerable: true, get() { getterCalled = true; throw new Error('PRIVATE-CANARY'); } });
  const nestedAccessor = fixture();
  Object.defineProperty(nestedAccessor.identity, 'ownerUserId', { enumerable: true, get() { getterCalled = true; return 'PRIVATE-CANARY'; } });
  const exotic = fixture(); Object.setPrototypeOf(exotic.identity, { token: 'PRIVATE-CANARY' });
  const symbol = fixture(); symbol[Symbol('PRIVATE-CANARY')] = 'secret';
  for (const invalid of [null, [], exotic, symbol, accessor, nestedAccessor]) {
    assert.throws(() => validate(invalid), error => error.message === 'Invalid sandbox profile'
      && error.code === 'SANDBOX_PROFILE_INVALID' && !JSON.stringify(error).includes('PRIVATE-CANARY'));
  }
  assert.equal(getterCalled, false);
});

test('compiles a pure frozen policy with hard limits and no sandbox secrets or arbitrary network', async () => {
  const compile = await compiler();
  const profile = fixture();
  const policy = compile(profile);
  assert.equal(policy.sandbox.runtime, 'runsc');
  assert.equal(policy.sandbox.networkMode, 'none');
  for (const unit of [policy.sandbox, policy.control]) {
    assert.equal(unit.user, '1000:1000');
    assert.equal(unit.readOnlyRootfs, true);
    assert.deepEqual(unit.capDrop, ['ALL']);
    assert.equal(unit.noNewPrivileges, true);
    assert.deepEqual(unit.publishedPorts, []);
    assert.deepEqual(unit.devices, []);
    assert.equal(unit.resources.memorySwapBytes, unit.resources.memoryBytes);
    assert.ok(unit.resources.cpuMillis > 0 && unit.resources.cpuMillis <= 2000);
    assert.ok(unit.resources.pidsLimit >= 16 && unit.resources.pidsLimit <= 256);
    assert.ok(unit.resources.tmpfsBytes > 0 && unit.resources.tmpfsBytes <= 64 * MiB);
    assert.equal(unit.resources.nofile, 1024);
    assert.deepEqual(unit.tmpfs, [{ target: '/tmp', bytes: unit.resources.tmpfsBytes, mode: '1777', noexec: true, nosuid: true, nodev: true }]);
    assert.deepEqual(unit.logging, { driver: 'none' });
    for (const forbidden of ['command', 'args', 'env', 'dockerArgs', 'dockerCommand']) assert.equal(forbidden in unit, false);
  }
  assert.deepEqual(policy.sandbox.mounts.map(m => [m.target, m.readOnly]), [
    ['/workspace', false], ['/agent-state', false], ['/run/channel', true],
  ]);
  assert.deepEqual(policy.control.mounts.map(m => [m.target, m.readOnly]), [
    ['/control-state', false], ['/run/channel', false], ['/run/secrets', true],
  ]);
  assert.equal(policy.control.mounts.some(m => policy.sandbox.mounts.slice(0, 2).some(s => s.source === m.source)), false);
  assert.equal(policy.sandbox.mounts.some(m => m.source === policy.paths.secrets || m.source === policy.paths.controlState), false);
  assert.equal(policy.control.networkMode, 'trusted-gateway-only');
  assert.equal(policy.control.gatewayUrl, profile.gatewayUrl);
  assert.equal(policy.sandbox.gatewayUrl, undefined);
  assert.deepEqual(policy.requirements.runsc, { required: true, hostUds: 'open', fallbackAllowed: false });
  assert.equal(policy.capacity.admissionImplemented, false);
  assert.equal(policy.capacity.controlMemoryBytes, policy.control.resources.memoryBytes);
  assert.equal(policy.capacity.runtimeOverheadBytes, null);
  assert.equal(policy.capacity.runtimeOverheadRequired, true);
  assertFrozen(policy);
});

test('requires actual block and inode hard quotas for workspace and session storage', async () => {
  const policy = (await compiler())(fixture());
  assert.equal(policy.requirements.storage.hardQuotaRequired, true);
  for (const target of ['/workspace', '/agent-state']) {
    const quota = policy.requirements.storage.quotas.find(q => q.target === target);
    assert.ok(quota);
    assert.equal(quota.bytes, fixture().resources.workspaceBytes);
    assert.equal(quota.inodes, fixture().resources.workspaceInodes);
    assert.equal(quota.enforcement, 'filesystem-hard-quota');
  }
});

test('hash-derived names and mounts isolate owners, organizations, agents and installations', async () => {
  const compile = await compiler();
  const original = compile(fixture());
  assert.deepEqual(compile(fixture()), original);
  for (const [section, key] of [['identity', 'ownerUserId'], ['identity', 'organizationId'], ['identity', 'agentId'], [null, 'installationId']]) {
    const input = fixture();
    if (section) input[section][key] += '-different'; else input[key] += '-different';
    const other = compile(input);
    for (const name of Object.keys(original.names)) assert.notEqual(original.names[name], other.names[name]);
    for (const source of Object.keys(original.paths)) assert.notEqual(original.paths[source], other.paths[source]);
  }
  for (const source of Object.values(original.paths)) {
    const relative = path.posix.relative(fixture().storageRoot, source);
    assert.ok(relative && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
    assert.equal(source.includes('owner-a'), false);
    assert.equal(source.includes('agent-a'), false);
  }
});

test('new run/generation/session rotates transient resources but preserves agent data', async () => {
  const compile = await compiler();
  const before = compile(fixture());
  for (const [key, changed] of [['runId', '33333333-3333-4333-8333-333333333333'],
    ['runGeneration', 2], ['sessionId', '44444444-4444-4444-8444-444444444444']]) {
    const input = fixture(); input.identity[key] = changed;
    const after = compile(input);
    for (const persistent of ['workspace', 'sessions', 'controlState']) assert.equal(after.paths[persistent], before.paths[persistent]);
    for (const ephemeral of ['channel', 'secrets']) assert.notEqual(after.paths[ephemeral], before.paths[ephemeral]);
    assert.notEqual(after.names.sandbox, before.names.sandbox);
    assert.notEqual(after.names.control, before.names.control);
  }
});

test('compiler revalidates input and never trusts previous validation or overriding identities', async () => {
  const compile = await compiler();
  const input = fixture(); input.identity.ownerUserId = 'owner/a';
  assert.throws(() => compile(input));
  assert.throws(() => compile({ ...fixture(), ownerUserId: 'other-owner' }));
  assert.throws(() => compile({ ...fixture(), network: 'host' }));
});

test('rejects even empty URL userinfo and Proxy-backed machine configuration', async () => {
  const validate = await validator();
  for (const gatewayUrl of ['https://@gateway.internal/v1', 'https://:@gateway.internal/v1']) {
    assert.throws(() => validate({ ...fixture(), gatewayUrl }));
  }
  let trapCalled = false;
  const proxied = new Proxy(fixture(), { get(target, key) { trapCalled = true; return target[key]; } });
  assert.throws(() => validate(proxied));
  assert.equal(trapCalled, false);
  const nested = fixture(); nested.resources = new Proxy(nested.resources, {});
  assert.throws(() => validate(nested));
});

test('rejects trailing control characters in all identifiers, image IDs and paths', async () => {
  const validate = await validator();
  for (const suffix of ['\n', '\r', '\r\n', '\t', '\0']) {
    for (const key of ['installationId', 'model', 'sandboxImage', 'controlImage', 'storageRoot', 'gatewayUrl']) {
      const value = fixture(); value[key] += suffix;
      assert.throws(() => validate(value), `${key} with ${JSON.stringify(suffix)}`);
    }
    for (const key of ['organizationId', 'ownerUserId', 'agentId', 'runId', 'sessionId']) {
      const value = fixture(); value.identity[key] += suffix;
      assert.throws(() => validate(value), `${key} with ${JSON.stringify(suffix)}`);
    }
  }
});

test('uses F1 lowercase UUID version and variant grammar without normalization', async () => {
  const validate = await validator();
  for (const key of ['runId', 'sessionId']) {
    for (const uuid of ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      '11111111-1111-0111-8111-111111111111', '11111111-1111-4111-1111-111111111111']) {
      const value = fixture(); value.identity[key] = uuid;
      assert.throws(() => validate(value));
    }
  }
});

test('accepts F2 catalog model identifiers including provider prefixes and colons', async () => {
  const validate = await validator();
  for (const model of ['provider/model', 'provider/model:revision', 'claude-3.7-sonnet', 'qwen/model-v1']) {
    const value = fixture(); value.model = model;
    assert.equal(validate(value).model, model);
  }
});
