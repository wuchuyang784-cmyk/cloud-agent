import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readControllerConfig } from '../src/runtime/supervision/config.mjs';
import { readOrchestratorConfig } from '../src/runtime/orchestrator/config.mjs';
import { DockerOrchestratorDriver, createArguments, containerName } from '../src/runtime/orchestrator/docker.mjs';

const installation = '0123456789abcdef01234567';
const common = { BAIRUI_RUNTIME_DEPLOYMENT: 'business', BAIRUI_RUNTIME_INSTALLATION: installation,
  BAIRUI_RUNTIME_DATABASE_HOST: 'runtime-db', BAIRUI_RUNTIME_DATABASE_PORT: '5432',
  BAIRUI_RUNTIME_CONTROL_KEY_ID: 'primary', BAIRUI_RUNTIME_CONTROL_SECRET: 'a'.repeat(64) };
const controller = { ...common, BAIRUI_RUNTIME_CONTROLLER_MODE: 'managed',
  BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL: 'postgresql://bairui_runtime_controller:pass@runtime-db:5432/bairui',
  BAIRUI_RUNTIME_ORCHESTRATOR_URL: 'https://runtime-orchestrator:9494',
  BAIRUI_RUNTIME_ALLOWED_CIDRS: '172.30.44.0/24', BAIRUI_RUNTIME_CONTROLLER_METRICS_TOKEN_FILE: '/run/secrets/metrics' };
const orchestrator = { ...common, BAIRUI_ORCHESTRATOR_MODE: 'managed',
  BAIRUI_ORCHESTRATOR_DATABASE_URL: 'postgresql://bairui_runtime_ledger:pass@runtime-db:5432/bairui_runtime_ledger_business',
  BAIRUI_ORCHESTRATOR_INSTALLATION: installation, BAIRUI_ORCHESTRATOR_NETWORK: 'runtime-private',
  BAIRUI_ORCHESTRATOR_IMAGE: `sha256:${'a'.repeat(64)}`,
  BAIRUI_ORCHESTRATOR_TLS_KEY_FILE: '/run/secrets/tls-key', BAIRUI_ORCHESTRATOR_TLS_CERT_FILE: '/run/secrets/tls-cert' };

test('managed controller accepts only deployment-specific business database and fixed role', () => {
  assert.equal(readControllerConfig(controller).host, '0.0.0.0');
  assert.equal(readControllerConfig({ ...controller, BAIRUI_RUNTIME_DEPLOYMENT: 'preprod',
    BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL: controller.BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL.replace(/\/bairui$/, '/bairui_preprod') }).host, '0.0.0.0');
  for (const replacement of ['bairui_preprod', 'postgres', 'bairui_runtime_ledger_business', 'bairui/extra']) {
    assert.throws(() => readControllerConfig({ ...controller, BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL:
      controller.BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL.replace(/\/bairui$/, '/' + replacement) }), /config_invalid/);
  }
});

test('managed orchestrator confines ledger to deployment and installation', () => {
  const config = readOrchestratorConfig(orchestrator);
  assert.equal(config.host, '0.0.0.0'); assert.equal(config.runtimeAddressMode, 'ip');
  assert.equal(readOrchestratorConfig({ ...orchestrator, BAIRUI_RUNTIME_DEPLOYMENT: 'preprod',
    BAIRUI_ORCHESTRATOR_DATABASE_URL: orchestrator.BAIRUI_ORCHESTRATOR_DATABASE_URL.replace('_business', '_preprod') }).host, '0.0.0.0');
  for (const replacement of ['bairui', 'bairui_preprod', 'bairui_runtime_ledger_preprod', 'postgres']) {
    assert.throws(() => readOrchestratorConfig({ ...orchestrator, BAIRUI_ORCHESTRATOR_DATABASE_URL:
      orchestrator.BAIRUI_ORCHESTRATOR_DATABASE_URL.replace('bairui_runtime_ledger_business', replacement) }), /config_invalid/);
  }
  assert.throws(() => readOrchestratorConfig({ ...orchestrator, BAIRUI_ORCHESTRATOR_INSTALLATION: 'f'.repeat(24) }), /config_invalid/);
});

test('managed database config rejects host, role, credential, port, query and deployment overrides', () => {
  for (const [base, read, key, role] of [[controller, readControllerConfig, 'BAIRUI_RUNTIME_CONTROLLER_DATABASE_URL', 'bairui_runtime_controller'],
    [orchestrator, readOrchestratorConfig, 'BAIRUI_ORCHESTRATOR_DATABASE_URL', 'bairui_runtime_ledger']]) {
    for (const replacement of [{ BAIRUI_RUNTIME_DATABASE_HOST: 'other-db' }, { BAIRUI_RUNTIME_DATABASE_HOST: '*' },
      { BAIRUI_RUNTIME_DATABASE_PORT: undefined }, { BAIRUI_RUNTIME_DATABASE_PORT: '5433' },
      { BAIRUI_RUNTIME_DEPLOYMENT: 'production' }, { BAIRUI_RUNTIME_INSTALLATION: 'bad' }, { DATABASE_URL: base[key] },
      { [key]: base[key].replace(role, 'postgres') }, { [key]: base[key].replace(':pass@', ':@') },
      { [key]: base[key].replace(':5432/', ':5433/') }, { [key]: base[key].replace(':5432/', '/') }]) {
      assert.throws(() => read({ ...base, ...replacement }), /config_invalid/);
    }
    for (const query of ['host=other', 'database=postgres', 'user=postgres', 'password=other', 'port=5433',
      'options=-c%20role=postgres', 'options=-c%20search_path=public&options=-c%20search_path=public']) {
      assert.throws(() => read({ ...base, [key]: base[key] + '?' + query }), /config_invalid/);
    }
    assert.ok(read({ ...base, [key]: base[key] + '?options=-c%20search_path=public' }));
  }
});

test('private config reader accepts only explicit bounded JSON string fields without leaking inherited credentials', async () => {
  const { loadManagedRuntimeEnvironment } = await import('../src/runtime/managed-config.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'runtime-private-test-'));
  const path = join(directory, 'config.json');
  try {
    // Every value below is a fixed test fixture, never a real credential.
    const env = { BAIRUI_RUNTIME_CONFIG_FILE: path, NODE_ENV: 'production', NODE_EXTRA_CA_CERTS: '/run/secrets/ca',
      DATABASE_URL: 'private-business-url', BAIRUI_RUNTIME_CONTROL_SECRET: 'inherited-secret' };
    const loaded = await loadManagedRuntimeEnvironment(env, async requested => {
      assert.equal(requested, path); return Buffer.from(JSON.stringify(controller));
    });
    assert.equal(loaded.BAIRUI_RUNTIME_CONTROL_SECRET, controller.BAIRUI_RUNTIME_CONTROL_SECRET);
    assert.equal(loaded.NODE_EXTRA_CA_CERTS, env.NODE_EXTRA_CA_CERTS);
    assert.equal(loaded.DATABASE_URL, undefined); assert.equal(env.BAIRUI_RUNTIME_CONTROL_SECRET, 'inherited-secret');
    await assert.rejects(loadManagedRuntimeEnvironment({}, async () => Buffer.from('{}')), /managed_config/);
    for (const value of [null, [], 'text', { DATABASE_URL: 'private' }, { NODE_EXTRA_CA_CERTS: 'late-ca' },
      { BAIRUI_RUNTIME_CONTROL_SECRET: 123 }, { BAIRUI_RUNTIME_CONTROL_SECRET: null }, { BAIRUI_RUNTIME_CONFIG_FILE: 'nested' },
      { BAIRUI_RUNTIME_CONTROL_SECRET: 'secret\u0000' }]) {
      await assert.rejects(loadManagedRuntimeEnvironment(env, async () => Buffer.from(JSON.stringify(value))), /managed_config/);
    }
    await assert.rejects(loadManagedRuntimeEnvironment(env, async () => Buffer.alloc(32769, 32)), /managed_config/);
    await assert.rejects(loadManagedRuntimeEnvironment(env, async () => { throw new Error('private path and password'); }), error =>
      /^runtime_managed_config_/.test(error.message) && !error.message.includes('private'));
    await writeFile(path, JSON.stringify(controller));
    assert.equal((await loadManagedRuntimeEnvironment(env)).BAIRUI_RUNTIME_DEPLOYMENT, 'business');
    const { startManagedRuntime } = await import('../src/runtime/managed-entry.mjs');
    await assert.rejects(startManagedRuntime('api', env), /managed_kind_invalid/);
    await writeFile(path, JSON.stringify({ ...controller, BAIRUI_RUNTIME_CONTROLLER_MODE: 'isolation' }));
    await assert.rejects(startManagedRuntime('controller', env), /managed_mode_required/);
    await writeFile(path, Buffer.alloc(32769, 32));
    await assert.rejects(loadManagedRuntimeEnvironment(env), /managed_config_invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function dockerFixture({ runtimeAddressMode, address = '172.30.44.6', running = true }) {
  const options = { installationId: installation, network: 'runtime-private', image: `sha256:${'a'.repeat(64)}`, runtimeAddressMode };
  const row = { agentId: 'agent', runId: 'run', runGeneration: 1, request: { resourceSpec: {
    cpuMillis: 200, memoryBytes: 134217728, pidsLimit: 32 } } };
  const args = createArguments(options, row);
  const labels = Object.fromEntries(args.flatMap((value, index) => value === '--label' ? [args[index + 1].split('=')] : []));
  const id = 'c'.repeat(64);
  const info = { Id: id, Image: options.image, State: { Running: running }, Config: { Labels: labels,
    User: '1000:1000', Entrypoint: ['node'], Cmd: args.slice(-2) }, Mounts: [], HostConfig: {
    ReadonlyRootfs: true, NanoCpus: 200e6, Memory: 134217728, MemorySwap: 134217728, PidsLimit: 32,
    NetworkMode: options.network, RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'none' },
    CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] },
  NetworkSettings: { Networks: { [options.network]: { IPAddress: address } } } };
  const driver = new DockerOrchestratorDriver({ ...options, execute: async command => command[0] === 'ps' ? id : JSON.stringify([info]) });
  return { driver, options, row };
}

test('managed Runtime address uses exact owned-network IPv4 while isolation retains hostname', async () => {
  const legacy = dockerFixture({});
  assert.equal((await legacy.driver.find(legacy.row)).runtimeUrl, `http://${containerName(installation, 'run')}:8092`);
  const managed = dockerFixture({ runtimeAddressMode: 'ip' });
  assert.equal((await managed.driver.find(managed.row)).runtimeUrl, 'http://172.30.44.6:8092');
  for (const address of ['', 'other-net', '::1', '172.30.44.6/path']) {
    const fixture = dockerFixture({ runtimeAddressMode: 'ip', address });
    await assert.rejects(fixture.driver.find(fixture.row), /runtime_address_invalid/);
  }
  const created = dockerFixture({ runtimeAddressMode: 'ip', address: '', running: false });
  assert.equal((await created.driver.find(created.row)).runtimeUrl, undefined);
  const cleanup = dockerFixture({ runtimeAddressMode: 'ip', address: '', running: true });
  assert.equal((await cleanup.driver.find({ ...cleanup.row, terminal: true })).id, 'c'.repeat(64));
});

test('managed entry and dedicated orchestrator image do not enable platform Docker access or dotenv', async () => {
  const entry = await readFile(new URL('../src/runtime/managed-entry.mjs', import.meta.url), 'utf8');
  assert.ok(!/dotenv|--env-file/.test(entry)); assert.match(entry, /SIGTERM/);
  const image = await readFile(new URL('../docker/orchestrator/Dockerfile', import.meta.url), 'utf8');
  assert.match(image, /FROM node:22-alpine/); assert.match(image, /apk add --no-cache docker-cli/);
  assert.match(image, /npm ci --omit=dev/); assert.match(image, /managed-entry\.mjs/);
  const buildContext = await readFile(new URL('../docker/orchestrator/Dockerfile.dockerignore', import.meta.url), 'utf8');
  assert.match(buildContext, /^\*\*/); assert.ok(!buildContext.includes('!output')); assert.ok(!buildContext.includes('!.env'));
  const platform = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.ok(!/apk add[^\n]*docker/.test(platform));
});
