import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAlertReceiver, readAlertRecords } from '../src/monitoring/alert-receiver.mjs';

const token = 'test-only-alert-token-'.repeat(3);
const names = ['ApiReplicaMissing', 'DatabaseUnavailable', 'ApiErrorRateHigh', 'ApiLatencyHigh',
  'DatabasePoolWaiting', 'MonitoringTargetDown', 'AlertDeliveryFailed'];

test('only liveness is public; there is no network record endpoint', async t => {
  const { url, directory } = await fixture(t);
  const live = await fetch(`${url}/livez`);
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await live.json(), { status: 'ok' });
  for (const path of ['/alerts', '/records', '/alerts.jsonl', '/livez?token=private']) {
    assert.equal((await fetch(url + path)).status, 404);
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('bearer authentication rejects missing, wrong, short and duplicate credentials', async t => {
  const { send, url, directory } = await fixture(t);
  for (const authorization of ['', 'Basic private', 'Bearer wrong', `Bearer ${'z'.repeat(token.length)}`,
    `Bearer ${token}suffix`, `Bearer ${token}, Bearer ${token}`]) {
    const response = await send(payload(), { authorization });
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes(token), false);
  }
  const duplicate = streamRequest(url, { authorization: [`Bearer ${token}`, `Bearer ${token}`] });
  duplicate.request.end(JSON.stringify(payload()));
  assert.equal((await duplicate.response).status, 401);
  assert.deepEqual(await readAlertRecords(directory), []);
});

test('persisted records contain only receipt time and four allowlisted alert fields', async t => {
  const { send, directory } = await fixture(t);
  const marker = 'SENSITIVE-cookie-email-sql-provider-key';
  const body = payload();
  Object.assign(body, { receiver: marker, groupKey: marker, externalURL: `https://example.test/${marker}`,
    commonLabels: { email: marker }, commonAnnotations: { summary: marker }, receivedAt: marker });
  Object.assign(body.alerts[0], { annotations: { description: marker }, generatorURL: marker,
    startsAt: marker, endsAt: marker, fingerprint: marker });
  body.alerts[0].labels.password = marker;
  body.alerts[0].labels.body = marker;
  const before = Date.now();
  assert.equal((await send(body)).status, 200);
  assert.equal((await send(payload('resolved'))).status, 200);
  const records = await readAlertRecords(directory);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.status), ['resolved', 'firing']);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['alertname', 'instance', 'receivedAt', 'severity', 'status']);
    assert.equal(record.alertname, 'DatabaseUnavailable');
    assert.equal(record.severity, 'critical');
    assert.equal(record.instance, '10.0.0.12:9464');
    assert.ok(Date.parse(record.receivedAt) >= before && Date.parse(record.receivedAt) <= Date.now());
  }
  assert.equal((await fs.readFile(join(directory, 'alerts.jsonl'), 'utf8')).includes(marker), false);
  assert.deepEqual(await readAlertRecords(directory, 1), records.slice(0, 1));
});

test('all seven approved alert names and aggregate alerts are accepted', async t => {
  const { send, directory } = await fixture(t);
  for (const alertname of names) {
    const body = payload('firing', { alertname });
    delete body.alerts[0].labels.instance;
    assert.equal((await send(body)).status, 200);
  }
  const records = await readAlertRecords(directory);
  assert.deepEqual(records.map(record => record.alertname), [...names].reverse());
  assert.ok(records.every(record => record.instance === null));
});

test('schema validation rejects the entire batch without reflecting untrusted input', async t => {
  const { send, directory } = await fixture(t);
  const invalid = [null, [], {}, { ...payload(), version: '3' }, { ...payload(), status: 'private' },
    { ...payload(), alerts: [] }, { ...payload(), alerts: {} }, { ...payload(), alerts: [null] },
    { ...payload(), alerts: [{ status: 'private', labels: payload().alerts[0].labels }] },
    { ...payload(), alerts: [{ status: 'firing', labels: [] }] },
    payload('firing', { alertname: 'private' }), payload('firing', { alertname: 'x'.repeat(500) }),
    payload('firing', { severity: 'private' }), payload('firing', { severity: null }),
    { ...payload(), alerts: [payload().alerts[0], ...payload('firing', { alertname: 'private' }).alerts] }];
  for (const body of invalid) {
    const response = await send(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.text()).includes('private'), false);
  }
  assert.equal((await send('{"private":')).status, 400);
  assert.deepEqual(await readAlertRecords(directory), []);
});

test('instance accepts IP:port and rejects unlisted hostnames, URLs, zones and secret strings', async t => {
  const { send, directory } = await fixture(t);
  for (const instance of ['127.0.0.1:1', '[2001:db8::1]:65535', '[::ffff:192.0.2.1]:9090']) {
    assert.equal((await send(payload('firing', { instance }))).status, 200);
  }
  for (const instance of ['private:9090', 'http://10.0.0.1:9090', '10.0.0.1:9090/private',
    '10.0.0.1:0', '10.0.0.1:65536', '999.1.1.1:9090', '::1:9090', '[fe80::1%private]:9090',
    '10.0.0.1:9090\nprivate', 'x'.repeat(1000), 42, null, {}]) {
    assert.equal((await send(payload('firing', { instance }))).status, 400, String(instance));
  }
  assert.equal((await readAlertRecords(directory)).length, 3);
});

test('monitor target alerts accept only the fixed deployment service names', async t => {
  const { send, directory } = await fixture(t);
  for (const instance of ['localhost:9090', 'bairui-monitor_alertmanager:9093', 'bairui-monitor_grafana:3000']) {
    assert.equal((await send(payload('firing', { alertname: 'MonitoringTargetDown', instance }))).status, 200, instance);
  }
  for (const instance of ['bairui-monitor_grafana:3001', 'bairui-monitor_grafana:3000.evil.test',
    'user-secret:3000', 'localhost:8080']) {
    assert.equal((await send(payload('firing', { alertname: 'MonitoringTargetDown', instance }))).status, 400);
  }
  assert.equal((await readAlertRecords(directory)).length, 3);
});

test('JSON content type, encoding, 64 KiB byte limit and 64 alert limit are enforced', async t => {
  const { send, url, directory } = await fixture(t);
  assert.equal((await send(payload(), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send(payload(), { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await send('x'.repeat(65537))).status, 413);
  const body = payload();
  body.padding = '';
  body.padding = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(body)));
  assert.equal((await send(body)).status, 200);
  body.padding += 'x';
  assert.equal((await send(body)).status, 413);
  const chunked = streamRequest(url);
  chunked.request.write(' '.repeat(40000));
  chunked.request.end(' '.repeat(30000));
  assert.equal((await chunked.response).status, 413);
  const many = payload();
  many.alerts = Array.from({ length: 65 }, () => payload().alerts[0]);
  assert.equal((await send(many)).status, 400);
  many.alerts.pop();
  assert.equal((await send(many)).status, 200);
  assert.equal((await readAlertRecords(directory)).length, 65);
});

function payload(status = 'firing', labels = {}) {
  return { version: '4', status, alerts: [{ status, labels: {
    alertname: 'DatabaseUnavailable', severity: 'critical', instance: '10.0.0.12:9464', ...labels,
  } }] };
}

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'bairui-alert-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t, options = {}) {
  const directory = options.directory ?? await tempDirectory(t);
  const server = createAlertReceiver({ token, directory, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, directory, url, send: (body = payload(), headers = {}) => fetch(`${url}/alerts`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) };
}

function streamRequest(url, headers = {}) {
  let resolve, reject;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  const request = httpRequest(`${url}/alerts`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers,
  } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  request.on('error', reject);
  return { request, response };
}

test('receiver requires strong credentials and bounded configuration', async t => {
  const directory = await tempDirectory(t);
  for (const invalid of [undefined, '', 'short', 'x'.repeat(31), ' '.repeat(40), 'x'.repeat(32) + '\n']) {
    assert.throws(() => createAlertReceiver({ token: invalid, directory }), /token/);
  }
  for (const options of [{ maxPending: 33 }, { maxPending: 0 }, { maxFiles: 4 }, { maxFiles: 0 },
    { maxFileBytes: 1048577 }, { maxFileBytes: 0 }, { maxPending: 1.5 }, { directory: '' }]) {
    assert.throws(() => createAlertReceiver({ token, directory, ...options }));
  }
});

function holdNextSync(t, fail = false) {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const completed = Promise.withResolvers();
  const open = fs.open.bind(fs);
  let syncs = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args);
    if (String(args[1]).startsWith('a')) {
      const sync = file.sync.bind(file);
      t.mock.method(file, 'sync', async () => {
        syncs++;
        if (syncs === 1) {
          entered.resolve();
          await gate.promise;
          if (fail) throw new Error('SENSITIVE-disk-error');
        }
        await sync();
        completed.resolve();
      });
    }
    return file;
  });
  t.after(() => gate.resolve());
  return { entered: entered.promise, completed: completed.promise, release: gate.resolve, syncs: () => syncs };
}

test('writes are serialized, acknowledge only after sync, and a full queue returns retryable 503', async t => {
  const { send, server, directory } = await fixture(t, { maxPending: 2 });
  const held = holdNextSync(t);
  let acknowledged = false;
  const first = send().then(response => { acknowledged = true; return response; });
  await held.entered;
  try {
    assert.equal(acknowledged, false);
    const incoming = once(server, 'request');
    const second = send(payload('resolved'));
    await incoming;
    const overflow = await send();
    assert.equal(overflow.status, 503);
    assert.equal(overflow.headers.get('retry-after'), '5');
    assert.equal(held.syncs(), 1);
    held.release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    assert.deepEqual((await readAlertRecords(directory)).map(record => record.status), ['resolved', 'firing']);
  } finally { held.release(); await first; }
});

test('incomplete uploads occupy the bounded queue and release their slot when aborted', async t => {
  const { send, server, url } = await fixture(t, { maxPending: 1 });
  const slow = streamRequest(url);
  slow.response.catch(() => {});
  const incoming = once(server, 'request');
  slow.request.write('{');
  await incoming;
  try { assert.equal((await send()).status, 503); }
  finally { slow.request.destroy(); }
  let response;
  for (let attempt = 0; attempt < 20; attempt++) {
    response = await send();
    if (response.status === 200) break;
    await delay(10);
  }
  assert.equal(response.status, 200);
});

test('rotation keeps at most three bounded files and survives restart', async t => {
  const first = await fixture(t, { maxFileBytes: 256 });
  for (let index = 1; index <= 8; index++) {
    assert.equal((await first.send(payload('firing', { instance: `10.0.0.${index}:9464` }))).status, 200);
  }
  const files = await fs.readdir(first.directory);
  assert.deepEqual(files.sort(), ['alerts.1.jsonl', 'alerts.2.jsonl', 'alerts.jsonl']);
  for (const file of files) assert.ok((await fs.stat(join(first.directory, file))).size <= 256);
  assert.deepEqual((await readAlertRecords(first.directory)).map(record => record.instance),
    ['10.0.0.8:9464', '10.0.0.7:9464', '10.0.0.6:9464']);
  await new Promise(resolve => first.server.close(resolve));
  const restarted = await fixture(t, { directory: first.directory, maxFileBytes: 256 });
  assert.equal((await restarted.send(payload('resolved'))).status, 200);
  const records = await readAlertRecords(first.directory);
  assert.equal(records.length, 3);
  assert.equal(records[0].status, 'resolved');
  assert.equal(records[1].instance, '10.0.0.8:9464');
});

test('batched and concurrent deliveries never split a line or exceed file bounds', async t => {
  const { send, directory } = await fixture(t, { maxFileBytes: 512 });
  const body = payload();
  body.alerts = Array.from({ length: 5 }, () => payload().alerts[0]);
  assert.equal((await send(body)).status, 200);
  assert.equal((await readAlertRecords(directory)).length, 5);
  const responses = await Promise.all(Array.from({ length: 16 }, () => send()));
  assert.ok(responses.every(response => response.status === 200));
  const files = await fs.readdir(directory);
  assert.equal(files.length, 3);
  for (const file of files) {
    const text = await fs.readFile(join(directory, file), 'utf8');
    assert.ok(Buffer.byteLength(text) <= 512);
    assert.ok(text.endsWith('\n'));
    for (const line of text.trim().split('\n')) assert.equal(JSON.parse(line).status, 'firing');
  }
});

test('real filesystem write failures return sanitized 503 and a later retry succeeds', async t => {
  const { send, directory, url } = await fixture(t);
  const path = join(directory, 'alerts.jsonl');
  await fs.mkdir(path);
  const response = await send();
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes(directory), false);
  assert.equal((await fetch(`${url}/livez`)).status, 200);
  await fs.rmdir(path);
  assert.equal((await send()).status, 200);
  assert.equal((await readAlertRecords(directory)).length, 1);
});

test('sync failures remain retryable and do not poison the serialized writer', async t => {
  const { send, directory } = await fixture(t);
  const held = holdNextSync(t, true);
  const pending = send();
  await held.entered;
  held.release();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('SENSITIVE'), false);
  assert.deepEqual(await readAlertRecords(directory), []);
  assert.equal((await send()).status, 200);
});

test('a partially failed append rolls back only that delivery and the next write recovers', async t => {
  const { send, directory } = await fixture(t);
  assert.equal((await send()).status, 200);
  const open = fs.open.bind(fs);
  let fail = true;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args);
    if (String(args[1]).startsWith('a') && fail) {
      const write = file.writeFile.bind(file);
      t.mock.method(file, 'writeFile', async buffer => {
        await write(buffer.subarray(0, 12));
        fail = false;
        throw new Error('SENSITIVE-partial-write');
      });
    }
    return file;
  });
  const response = await send(payload('resolved'));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('SENSITIVE'), false);
  assert.equal((await readAlertRecords(directory)).length, 1);
  assert.equal((await send(payload('resolved'))).status, 200);
  assert.deepEqual((await readAlertRecords(directory)).map(record => record.status), ['resolved', 'firing']);
});

test('rotation failures are retryable and never poison later deliveries', async t => {
  const { send, directory } = await fixture(t, { maxFileBytes: 256 });
  assert.equal((await send()).status, 200);
  const rename = fs.rename.bind(fs);
  let fail = true;
  t.mock.method(fs, 'rename', async (...args) => {
    if (fail) { fail = false; throw new Error('SENSITIVE-rotation-error'); }
    return rename(...args);
  });
  const response = await send(payload('resolved'));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('SENSITIVE'), false);
  assert.equal((await send(payload('resolved'))).status, 200);
  assert.deepEqual((await readAlertRecords(directory)).map(record => record.status), ['resolved', 'firing']);
});

test('default storage rotates at 1 MiB and retains at most three files', async t => {
  const { send, directory } = await fixture(t);
  assert.equal((await send()).status, 200);
  const line = await fs.readFile(join(directory, 'alerts.jsonl'), 'utf8');
  const full = line.repeat(Math.floor(1048576 / Buffer.byteLength(line)));
  for (let rotation = 0; rotation < 4; rotation++) {
    await fs.writeFile(join(directory, 'alerts.jsonl'), full);
    assert.equal((await send()).status, 200);
  }
  const files = await fs.readdir(directory);
  assert.equal(files.length, 3);
  for (const file of files) assert.ok((await fs.stat(join(directory, file))).size <= 1048576);
  assert.equal((await readAlertRecords(directory)).length, 100);
});

test('single-file retention replaces a full file without creating any archives', async t => {
  const { send, directory } = await fixture(t, { maxFileBytes: 256, maxFiles: 1 });
  assert.equal((await send()).status, 200);
  assert.equal((await send(payload('resolved'))).status, 200);
  assert.deepEqual(await fs.readdir(directory), ['alerts.jsonl']);
  assert.deepEqual((await readAlertRecords(directory)).map(record => record.status), ['resolved']);
});

test('local reads sanitize existing lines, skip corrupt tails, and surface read failures safely', async t => {
  const { send, directory } = await fixture(t);
  await send();
  const [record] = await readAlertRecords(directory);
  const path = join(directory, 'alerts.jsonl');
  await fs.writeFile(path, JSON.stringify({ ...record, annotations: 'SENSITIVE' }) + '\nnot-json\n{"SENSITIVE":');
  assert.deepEqual(await readAlertRecords(directory), [record]);
  assert.deepEqual(await readAlertRecords(directory, 0), []);
  await assert.rejects(readAlertRecords(directory, -1));
  await fs.unlink(path);
  await fs.mkdir(path);
  await assert.rejects(readAlertRecords(directory), /^Error: alert_records_unavailable$/);
  await fs.rmdir(path);
  await fs.writeFile(path, 'x'.repeat(1048577));
  await assert.rejects(readAlertRecords(directory), /^Error: alert_records_unavailable$/);
});

test('restart repairs an interrupted final line before appending a complete record', async t => {
  const { send, directory } = await fixture(t);
  await send();
  await fs.appendFile(join(directory, 'alerts.jsonl'), '{"interrupted":');
  assert.equal((await send(payload('resolved'))).status, 200);
  const records = await readAlertRecords(directory);
  assert.deepEqual(records.map(record => record.status), ['resolved', 'firing']);
  assert.equal((await fs.readFile(join(directory, 'alerts.jsonl'), 'utf8')).includes('interrupted'), false);
});

test('default admission is capped at 32 including slow bodies', async t => {
  const { server, send, url } = await fixture(t);
  const requests = [];
  try {
    for (let index = 0; index < 32; index++) {
      const slow = streamRequest(url);
      slow.response.catch(() => {});
      requests.push(slow.request);
      const incoming = once(server, 'request');
      slow.request.write('{');
      await incoming;
    }
    assert.equal((await send()).status, 503);
    assert.equal((await fetch(`${url}/livez`)).status, 200);
  } finally { for (const request of requests) request.destroy(); }
});

test('HTTP timeouts are finite and a slow body gets 408 without poisoning capacity', { timeout: 2000 }, async t => {
  const { server, send, url } = await fixture(t, { maxPending: 1 });
  assert.ok(server.requestTimeout > 0 && server.requestTimeout <= 15000);
  assert.ok(server.headersTimeout > 0 && server.headersTimeout <= server.requestTimeout);
  assert.ok(server.keepAliveTimeout > 0 && server.keepAliveTimeout <= 5000);
  server.requestTimeout = 40;
  const slow = streamRequest(url);
  slow.response.catch(() => {});
  t.after(() => slow.request.destroy());
  slow.request.write('{');
  assert.equal((await slow.response).status, 408);
  server.requestTimeout = 1000;
  assert.equal((await send()).status, 200);
});

test('a timed-out disk write keeps its slot and shutdown waits for actual completion', { timeout: 3000 }, async t => {
  const { server, send, directory } = await fixture(t, { maxPending: 1 });
  server.requestTimeout = 60;
  const held = holdNextSync(t);
  const pending = send();
  await held.entered;
  try {
    assert.equal((await pending).status, 503);
    assert.equal((await send()).status, 503);
    let stopped = false;
    const closed = new Promise(resolve => server.close(() => { stopped = true; resolve(); }));
    await delay(20);
    assert.equal(stopped, false);
    held.release();
    await closed;
    assert.equal((await readAlertRecords(directory)).length, 1);
  } finally { held.release(); await pending; }
});

test('expired queued deliveries are not written after an earlier blocked write recovers', { timeout: 3000 }, async t => {
  const { server, send, directory } = await fixture(t);
  server.requestTimeout = 60;
  const held = holdNextSync(t);
  const first = send();
  await held.entered;
  const second = send(payload('resolved'));
  try {
    assert.equal((await first).status, 503);
    assert.equal((await second).status, 503);
  } finally { held.release(); }
  await new Promise(resolve => server.close(resolve));
  assert.deepEqual((await readAlertRecords(directory)).map(record => record.status), ['firing']);
});

test('shutdown drains accepted writes and releases the listening port', async t => {
  const { server, send, url, directory } = await fixture(t);
  const held = holdNextSync(t);
  const first = send();
  await held.entered;
  const incoming = once(server, 'request');
  const second = send(payload('resolved'));
  const [request] = await incoming;
  if (!request.readableEnded) await once(request, 'end');
  let stopped = false;
  const closed = new Promise(resolve => server.close(() => { stopped = true; resolve(); }));
  assert.equal(stopped, false);
  held.release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  await closed;
  assert.equal(server.listening, false);
  await assert.rejects(fetch(`${url}/livez`));
  assert.equal((await readAlertRecords(directory)).length, 2);
});

test('shutdown rejects incomplete uploads instead of waiting indefinitely', { timeout: 2000 }, async t => {
  const { server, url } = await fixture(t);
  const slow = streamRequest(url);
  slow.response.catch(() => {});
  t.after(() => slow.request.destroy());
  const incoming = once(server, 'request');
  slow.request.write('{');
  await incoming;
  const closed = new Promise(resolve => server.close(resolve));
  assert.equal((await slow.response).status, 503);
  await closed;
});

async function launchEntrypoint(t, env, signalHarness = false) {
  const entry = new URL('../src/monitoring/alert-receiver-index.mjs', import.meta.url);
  const script = `process.on('message', () => { process.disconnect(); process.emit('SIGTERM'); }); await import(${JSON.stringify(entry.href)});`;
  const child = spawn(process.execPath, signalHarness ? ['--input-type=module', '--eval', script] : [fileURLToPath(entry)], {
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PORT: '0', ...env },
    stdio: signalHarness ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'close');
  const ready = Promise.withResolvers();
  ready.promise.catch(() => {});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.event === 'alert_receiver_listening') ready.resolve(event.port);
      } catch { /* Wait for a complete startup line. */ }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('exit', () => ready.reject(new Error('receiver_did_not_start')));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return { child, exited, ready: ready.promise, output: () => stdout + stderr,
    stop: () => child.send('stop'), entry: fileURLToPath(entry) };
}

test('entrypoint reads only its Secret file, persists alerts, and handles graceful shutdown', { timeout: 5000 }, async t => {
  const directory = await tempDirectory(t);
  const tokenFile = join(directory, 'token-secret');
  await fs.writeFile(tokenFile, token + '\n');
  const running = await launchEntrypoint(t, { BAIRUI_ALERT_TOKEN_FILE: tokenFile, BAIRUI_ALERT_DATA_DIR: directory }, true);
  const port = await running.ready;
  const response = await fetch(`http://127.0.0.1:${port}/alerts`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload()) });
  assert.equal(response.status, 200);
  running.stop();
  assert.deepEqual(await running.exited, [0, null]);
  assert.equal((await readAlertRecords(directory)).length, 1);
  assert.equal(running.output().includes(token), false);
  assert.equal(running.output().includes(directory), false);
});

test('entrypoint fails closed on missing or weak Secret and invalid settings without leaking details', { timeout: 10000 }, async t => {
  const directory = await tempDirectory(t);
  const weak = join(directory, 'SENSITIVE-token-path');
  const strong = join(directory, 'strong-token');
  await fs.writeFile(weak, 'SENSITIVE-weak');
  await fs.writeFile(strong, token);
  const variants = [
    { BAIRUI_ALERT_TOKEN_FILE: join(directory, 'SENSITIVE-missing'), BAIRUI_ALERT_TOKEN: token },
    { BAIRUI_ALERT_TOKEN_FILE: weak },
    { BAIRUI_ALERT_TOKEN_FILE: strong, PORT: 'private-port' },
    { BAIRUI_ALERT_TOKEN_FILE: strong, PORT: '65536' },
    { BAIRUI_ALERT_TOKEN_FILE: strong, BAIRUI_ALERT_DATA_DIR: '' },
  ];
  for (const env of variants) {
    const running = await launchEntrypoint(t, { BAIRUI_ALERT_DATA_DIR: directory, ...env });
    assert.deepEqual(await running.exited, [1, null]);
    assert.equal(running.output().trim(), 'alert_receiver_start_failed');
  }
});
