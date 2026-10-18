import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_BYTES = 512 * 1024, MAX_AGE = 45000;
const required = ['node_cpu_seconds_total', 'node_memory_MemTotal_bytes', 'node_memory_MemAvailable_bytes', 'node_time_seconds', 'node_boot_time_seconds'];
const families = new Map([
  ['node_cpu_seconds_total', ['cpu', 'mode']],
  ...['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'].map(name => ['node_memory_' + name + '_bytes', []]),
  ['node_boot_time_seconds', []], ['node_time_seconds', []],
  ...['size_bytes', 'avail_bytes', 'free_bytes', 'files', 'files_free', 'readonly', 'device_error'].map(name => ['node_filesystem_' + name, ['device', 'fstype', 'mountpoint', 'device_error']]),
  ...['read_bytes_total', 'written_bytes_total', 'reads_completed_total', 'writes_completed_total', 'io_time_seconds_total'].map(name => ['node_disk_' + name, ['device']]),
  ...['receive_bytes_total', 'transmit_bytes_total', 'receive_errs_total', 'transmit_errs_total', 'receive_drop_total', 'transmit_drop_total'].map(name => ['node_network_' + name, ['device']]),
]);
const invalid = () => { throw new Error('host_metrics_unavailable'); };

export function filterHostMetrics(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_BYTES) invalid();
  const result = [], seen = new Set(), series = new Set();
  for (const line of input.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const name = line.match(/^[A-Za-z_:][A-Za-z0-9_:]*/)?.[0];
    if (name === 'node_scrape_collector_success') {
      if (!/^node_scrape_collector_success\{collector="[a-z]+"\} 1$/.test(line)) invalid();
      continue;
    }
    if (!families.has(name)) continue;
    const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(\{([^{}\r\n]*)\})? ([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/);
    if (!match || !Number.isFinite(Number(match[4])) || Number(match[4]) < 0 || result.length >= 4096) invalid();
    const labels = match[3] ?? '', allowed = families.get(name), keys = new Set();
    let offset = 0;
    const label = /([A-Za-z_]\w*)="((?:[^"\\\r\n]|\\[\\n"])*)"/y;
    while (offset < labels.length) {
      label.lastIndex = offset; const item = label.exec(labels);
      if (!item || !allowed.includes(item[1]) || keys.has(item[1]) || item[2].length > 256) invalid();
      keys.add(item[1]); offset = label.lastIndex;
      if (offset < labels.length && labels[offset++] !== ',') invalid();
      if (offset === labels.length && labels.endsWith(',')) invalid();
    }
    const identity = name + '{' + labels + '}';
    if (series.has(identity)) invalid();
    series.add(identity); seen.add(name); result.push(line);
  }
  if (required.some(name => !seen.has(name))) invalid();
  return result.join('\n') + '\n';
}

export async function writeHostSnapshot(directory, text, sampledAt = Date.now()) {
  if (!Number.isSafeInteger(sampledAt) || sampledAt <= 0) invalid();
  const value = JSON.stringify({ version: 1, sampledAt, text: filterHostMetrics(text) });
  if (Buffer.byteLength(value) > MAX_BYTES) invalid();
  const temporary = join(directory, 'snapshot.tmp');
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, join(directory, 'snapshot.json'));
}

export async function readHostSnapshot(directory, now = Date.now()) {
  const file = await open(join(directory, 'snapshot.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let value;
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > MAX_BYTES) invalid();
    const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
    for (;;) { const { bytesRead } = await file.read(buffer, length, buffer.length - length, null); length += bytesRead; if (length > MAX_BYTES) invalid(); if (!bytesRead) break; }
    value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } finally { await file.close(); }
  if (value?.version !== 1 || Object.keys(value).sort().join(',') !== 'sampledAt,text,version' || !Number.isSafeInteger(value.sampledAt)
    || value.sampledAt > now || now - value.sampledAt > MAX_AGE) invalid();
  return filterHostMetrics(value.text) + '# TYPE bairui_host_metrics_sample_timestamp_seconds gauge\nbairui_host_metrics_sample_timestamp_seconds ' + value.sampledAt / 1000 + '\n';
}

export async function sampleHostMetrics({ directory, fetchImpl = fetch, now = Date.now, signal } = {}) {
  try {
    const sampledAt = now();
    const response = await fetchImpl('http://127.0.0.1:19100/metrics', { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
    if (!response.ok || !response.body) { await response.body?.cancel(); invalid(); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) invalid(); chunks.push(value); }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    await writeHostSnapshot(directory, Buffer.concat(chunks).toString('utf8'), sampledAt);
  } catch {
    await unlink(join(directory, 'snapshot.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    invalid();
  }
}

export function createHostMetricsBridge({ directory, now = Date.now } = {}) {
  let active = 0;
  return createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 }, async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method) || !['/metrics', '/livez'].includes(request.url)) { response.writeHead(404); response.end(); return; }
    if (request.url === '/livez') { response.writeHead(200); response.end(); return; }
    if (active >= 4) { response.writeHead(503); response.end('Host metrics unavailable'); return; }
    active++;
    try {
      const text = await readHostSnapshot(directory, now());
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' }); response.end(request.method === 'HEAD' ? undefined : text);
    } catch { response.writeHead(503); response.end('Host metrics unavailable'); }
    finally { active--; }
  });
}

async function main(mode) {
  const directory = '/data';
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
  if (mode === 'sampler') {
    while (!abort.signal.aborted) {
      try { await sampleHostMetrics({ directory, signal: abort.signal }); } catch { if (!abort.signal.aborted) console.error('host_metrics_sample_failed'); }
      try { await delay(15000, undefined, { signal: abort.signal }); } catch { break; }
    }
  } else if (mode === 'bridge') {
    const server = createHostMetricsBridge({ directory });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(9100, '0.0.0.0', resolve); });
    abort.signal.addEventListener('abort', () => { server.close(); server.closeAllConnections(); }, { once: true });
  } else throw new Error('host_metrics_mode_invalid');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.length === 3 ? process.argv[2] : '').catch(() => { console.error('host_metrics_start_failed'); process.exitCode = 1; });
}
