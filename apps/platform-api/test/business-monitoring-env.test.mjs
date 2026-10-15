import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBusinessMonitoringEnv } from '../src/admin/business-monitoring-env.mjs';
import { createHostSampler } from '../src/observability/host-metrics.mjs';

test('business monitoring config is explicit, bounded, preserves business credentials and rejects unsafe connectors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bairui-monitor-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bridge = join(dir, 'bridge-token'), metrics = join(dir, 'metrics-token'), file = join(dir, 'connector.json');
  await writeFile(bridge, '1234567890abcdef'.repeat(4)); await writeFile(metrics, 'abcdef1234567890'.repeat(4));
  const config = { version: 1, installation: 'a'.repeat(24), upstreamUrl: 'http://127.0.0.1:9493', publicOrigin: 'http://localhost:5173', metricsPort: 9465,
    bridgeTokenFile: bridge, metricsTokenFile: metrics };
  await writeFile(file, JSON.stringify(config));
  const original = { NODE_ENV: 'development', DATABASE_URL: 'do-not-change', BETTER_AUTH_SECRET: 'keep', BAIRUI_ADMIN_MONITORING_CONFIG_FILE: file };
  const env = await loadBusinessMonitoringEnv(original);
  assert.equal(env.DATABASE_URL, 'do-not-change'); assert.equal(env.BETTER_AUTH_SECRET, 'keep');
  assert.equal(env.BAIRUI_PROMETHEUS_URL, 'http://127.0.0.1:9493/prometheus');
  assert.equal(env.BAIRUI_GRAFANA_UPSTREAM_URL, config.upstreamUrl);
  assert.equal(env.BAIRUI_METRICS_TOKEN_FILE, metrics); assert.equal(env.BAIRUI_METRICS_ENABLED, '1');
  assert.equal(original.BAIRUI_METRICS_ENABLED, undefined);
  await assert.rejects(loadBusinessMonitoringEnv({ ...original, NODE_ENV: 'production' }), /invalid_business_monitoring/);
  for (const invalid of [{ ...config, DATABASE_URL: 'overwrite' }, { ...config, upstreamUrl: 'http://attacker.example' }, { ...config, metricsPort: 8080 }]) {
    await writeFile(file, JSON.stringify(invalid)); await assert.rejects(loadBusinessMonitoringEnv(original), /invalid_business_monitoring/);
  }
  assert.deepEqual(await loadBusinessMonitoringEnv({ DATABASE_URL: 'keep' }), { DATABASE_URL: 'keep' });
});

test('host CPU is a measured interval ratio, memory is actual OS data and absent CPU is not fabricated zero', () => {
  let total = 100, idle = 50;
  const sampler = createHostSampler({ cpus: () => [{ times: { user: total - idle, nice: 0, sys: 0, idle, irq: 0 } }], totalmem: () => 1024, freemem: () => 256 });
  assert.ok(Number.isNaN(sampler.cpu()));
  total = 200; idle = 75;
  assert.equal(sampler.cpu(), 0.75);
  assert.equal(sampler.memory().used, 768); assert.equal(sampler.memory().total, 1024);
  const empty = createHostSampler({ cpus: () => [], totalmem: () => 0, freemem: () => 0 });
  assert.ok(Number.isNaN(empty.cpu())); assert.ok(Number.isNaN(empty.memory().used));
});

test('explicit cloud version 2 connector supports production HTTPS and retains bounded fixed bridge secrets', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bairui-monitor-cloud-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bridge = join(dir, 'bridge-token'), metrics = join(dir, 'metrics-token'), file = join(dir, 'connector.json');
  await writeFile(bridge, 'a'.repeat(64)); await writeFile(metrics, 'b'.repeat(64));
  const config = { version: 2, installation: 'a'.repeat(24), upstreamUrl: 'http://127.0.0.1:9493', publicOrigin: 'https://cloud.example.test', metricsPort: 9465,
    bridgeTokenFile: bridge, metricsTokenFile: metrics };
  const original = { NODE_ENV: 'production', DATABASE_URL: 'keep', BAIRUI_ADMIN_MONITORING_CONFIG_FILE: file };
  await writeFile(file, JSON.stringify(config));
  const result = await loadBusinessMonitoringEnv(original);
  assert.equal(result.BAIRUI_GRAFANA_PUBLIC_ORIGIN, config.publicOrigin);
  assert.equal(result.BAIRUI_GRAFANA_AUTH_MODE, 'bearer');
  assert.equal(result.BAIRUI_MONITORING_SCOPE, 'business');
  assert.equal(result.BAIRUI_GRAFANA_UPSTREAM_URL, config.upstreamUrl);
  assert.equal(result.BAIRUI_MONITORING_PROXY_TOKEN, 'a'.repeat(64));
  assert.equal(result.DATABASE_URL, 'keep');
  for (const invalid of [{ ...config, version: 1 }, { ...config, publicOrigin: 'http://cloud.example.test' }, { ...config, publicOrigin: 'https://localhost' },
    { ...config, publicOrigin: 'http://localhost:5173' }, { ...config, publicOrigin: 'https://cloud.example.test/path' },
    { ...config, upstreamUrl: 'http://localhost:9493' }, { ...config, extra: true }, { ...config, metricsTokenFile: 'relative' }]) {
    await writeFile(file, JSON.stringify(invalid)); await assert.rejects(loadBusinessMonitoringEnv(original), /invalid_business_monitoring_configuration/);
  }
  await writeFile(file, JSON.stringify(config)); await writeFile(bridge, 'a'.repeat(66));
  await assert.rejects(loadBusinessMonitoringEnv(original), /invalid_business_monitoring_configuration/);
});
