import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAlertReceiver, readAlertRecords } from '../src/monitoring/alert-receiver.mjs';

const snapshot = { active: 2, stopping: 1, stopOverdue: 1, deadPending: 1, observationErrors: 1, observationStale: 2 };
const names = ['RuntimeControllerUnavailable', 'RuntimeControllerCycleFailed', 'RuntimeStopOverdue', 'RuntimeCommandDead', 'RuntimeObservationUnavailable'];
async function fixture(t) {
  const { createRuntimeTelemetry } = await import('../src/runtime/supervision/telemetry.mjs');
  const token = randomBytes(32).toString('hex');
  const telemetry = createRuntimeTelemetry({ token });
  t.after(() => telemetry.close());
  await telemetry.start();
  const url = `http://127.0.0.1:${telemetry.server.address().port}`;
  const read = async () => (await fetch(url + '/metrics', { headers: { authorization: `Bearer ${token}` } })).text();
  return { telemetry, token, url, read };
}
test('runtime metrics reject weak configuration and missing/wrong/duplicate authentication', async t => {
  const { telemetry, token, url } = await fixture(t);
  const { createRuntimeTelemetry } = await import('../src/runtime/supervision/telemetry.mjs');
  for (const token of ['', 'short', 'x'.repeat(64), 'abcd1234'.repeat(8), 'a b'.repeat(30)]) {
    assert.throws(() => createRuntimeTelemetry({ token }), /token/);
  }
  for (const authorization of ['', 'Basic abc', 'Bearer wrong', `Bearer ${token}, Bearer ${token}`]) {
    assert.equal((await fetch(url + '/metrics', { headers: { authorization } })).status, 401);
  }
  const duplicate = await new Promise((resolve, reject) => {
    const req = request(url + '/metrics', { headers: { authorization: [`Bearer ${token}`, `Bearer ${token}`] } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(duplicate, 401);
  for (const [path, method] of [['/metrics?token=secret', 'GET'], ['/livez', 'GET'], ['/metrics', 'POST']]) {
    assert.equal((await fetch(url + path, { method, headers: { authorization: `Bearer ${token}` } })).status, 404);
  }
  assert.ok(telemetry.server.headersTimeout <= 5000 && telemetry.server.requestTimeout <= 5000);
});
test('runtime metrics start unknown, publish only complete snapshots and retain last success on failure', async t => {
  const { telemetry, read } = await fixture(t);
  let text = await read();
  assert.match(text, /bairui_runtime_controller_cycle_ok 0/);
  assert.doesNotMatch(text, /^bairui_runtime_active /m);
  assert.doesNotMatch(text, /^bairui_runtime_controller_last_success_timestamp_seconds /m);
  telemetry.update({ ok: true, snapshot });
  text = await read();
  assert.match(text, /bairui_runtime_active 2/);
  assert.match(text, /bairui_runtime_observation_stale 2/);
  const timestamp = text.match(/^bairui_runtime_controller_last_success_timestamp_seconds (.+)$/m)[1];
  telemetry.update({ ok: false, snapshot: Object.fromEntries(Object.keys(snapshot).map(key => [key, 0])) });
  text = await read();
  assert.match(text, /bairui_runtime_controller_cycle_ok 0/);
  assert.match(text, /bairui_runtime_stop_overdue 1/);
  assert.equal(text.match(/^bairui_runtime_controller_last_success_timestamp_seconds (.+)$/m)[1], timestamp);
  for (const value of [-1, 1.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.throws(() => telemetry.update({ ok: true, snapshot: { ...snapshot, active: value } }), /snapshot/);
  }
  assert.doesNotMatch(await read(), /\{|process_|nodejs_|token|email/);
  const other = await fixture(t);
  assert.doesNotMatch(await other.read(), /^bairui_runtime_active /m);
});
test('five fixed aggregate runtime rules keep expressions unchanged when only timing is shortened', async () => {
  const { runtimeRules } = await import('../../../scripts/runtime-monitoring-config.mjs');
  const standard = runtimeRules().groups[0].rules;
  const quick = runtimeRules({ duration: '2s', interval: '1s' }).groups[0].rules;
  assert.deepEqual(standard.map(rule => rule.alert), names);
  assert.deepEqual(standard.map(rule => rule.expr), quick.map(rule => rule.expr));
  for (const rule of standard) { assert.equal(rule.for, '45s'); assert.match(rule.expr, /bairui-runtime-controller/); }
  assert.match(standard[0].expr, /60/);
});
test('runtime firing and resolved notifications are accepted and durably read without instance identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bairui-runtime-alert-test-'));
  const token = randomBytes(32).toString('hex');
  const server = createAlertReceiver({ token, directory });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const status of ['firing', 'resolved']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/alerts`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: '4', status, alerts: names.map(alertname => ({ status, labels: { alertname, severity: 'critical' } })) }) });
    assert.equal(response.status, 200);
  }
  const records = await readAlertRecords(directory);
  assert.equal(records.length, 10);
  assert.ok(records.every(record => record.instance === null));
});
