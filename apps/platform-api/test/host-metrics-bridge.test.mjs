import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let api = {};
try { api = await import('../src/observability/host-metrics-bridge.mjs'); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const sample = 'node_cpu_seconds_total{cpu="0",mode="idle"} 100\nnode_memory_MemTotal_bytes 8192\nnode_memory_MemAvailable_bytes 4096\nnode_time_seconds 1700000000\nnode_boot_time_seconds 1699990000\nnode_network_receive_bytes_total{device="eth0"} 1024\n';
test('M1 exposes bounded snapshot sampling and a read-only bridge', () => {
  for (const name of ['filterHostMetrics', 'writeHostSnapshot', 'readHostSnapshot', 'sampleHostMetrics', 'createHostMetricsBridge']) assert.equal(typeof api[name], 'function', name);
});
test('only finite allowlisted node families pass, without addresses, custom labels or arbitrary metrics', () => {
  const text = api.filterHostMetrics(sample + 'process_resident_memory_bytes 90\nnode_uname_info{nodename="private-host"} 1\n');
  assert.match(text, /node_cpu_seconds_total/); assert.doesNotMatch(text, /process_|private-host/);
  for (const value of [sample + 'node_memory_MemTotal_bytes NaN\n', sample + 'node_memory_MemTotal_bytes +Inf\n', sample + 'node_memory_MemTotal_bytes -1\n', sample + 'node_memory_MemTotal_bytes{secret="x"} 1\n', 'x'.repeat(524289)]) assert.throws(() => api.filterHostMetrics(value));
});
test('source collector failures and missing core metrics are not published as healthy host samples', () => {
  assert.throws(() => api.filterHostMetrics(sample + 'node_scrape_collector_success{collector="filesystem"} 0\n'));
  assert.throws(() => api.filterHostMetrics('node_time_seconds 1\n'));
});
test('atomic snapshots retain source time and reject stale, future, malformed or oversized files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'm1-cache-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.now(); await api.writeHostSnapshot(directory, sample, now);
  const text = await api.readHostSnapshot(directory, now + 1000);
  assert.match(text, new RegExp('bairui_host_metrics_sample_timestamp_seconds ' + now / 1000));
  await assert.rejects(api.readHostSnapshot(directory, now + 45001)); await assert.rejects(api.readHostSnapshot(directory, now - 1));
  const file = join(directory, 'snapshot.json');
  for (const value of ['not-json', JSON.stringify({ version: 2, sampledAt: now, text: sample }), 'x'.repeat(524289)]) {
    await writeFile(file, value); await assert.rejects(api.readHostSnapshot(directory, now));
  }
});
test('sampler fetches only the fixed loopback address with deadline and clears a previously valid sample on failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'm1-sampler-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let called = false;
  await api.sampleHostMetrics({ directory, fetchImpl: async (url, options) => { called = true; assert.equal(url, 'http://127.0.0.1:19100/metrics'); assert.equal(options.redirect, 'error'); assert.ok(options.signal); return new Response(sample); } });
  assert.equal(called, true); assert.match(await api.readHostSnapshot(directory), /node_memory_MemTotal_bytes/);
  await assert.rejects(api.sampleHostMetrics({ directory, fetchImpl: async () => new Response('bad', { status: 503 }) }));
  await assert.rejects(readFile(join(directory, 'snapshot.json')));
});
test('HTTP bridge serves only fixed metrics/live paths and never stale resource values', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'm1-http-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now(); await api.writeHostSnapshot(directory, sample, now);
  const server = api.createHostMetricsBridge({ directory, now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(url + '/metrics'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(await response.text(), /node_cpu_seconds_total/);
  for (const path of ['/metrics?file=/etc/passwd', '/unknown']) assert.equal((await fetch(url + path)).status, 404);
  assert.equal((await fetch(url + '/metrics', { method: 'POST' })).status, 404);
  now += 45001; const stale = await fetch(url + '/metrics'); assert.equal(stale.status, 503); assert.doesNotMatch(await stale.text(), /node_cpu|\/etc|m1-http/);
  assert.equal((await fetch(url + '/livez')).status, 200);
});
