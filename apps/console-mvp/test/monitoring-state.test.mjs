import test from 'node:test';
import assert from 'node:assert/strict';
import { MonitoringResource } from '../src/monitoring-state.ts';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('monitoring view: changing filters clears old data and ignores stale success', async () => {
  const model = new MonitoringResource();
  const pending = deferred();
  const first = model.load('agent-a:today', () => pending.promise);
  await model.load('agent-b:7d', async () => ({ agent: 'b' }));
  pending.resolve({ agent: 'a' }); await first;
  assert.equal(model.getSnapshot().key, 'agent-b:7d');
  assert.deepEqual(model.getSnapshot().data, { agent: 'b' });
  let resolve;
  const next = model.load('agent-b:30d', () => new Promise(r => { resolve = r; }));
  assert.equal(model.getSnapshot().data, null);
  resolve({ agent: 'b30' }); await next;
});

test('monitoring view: disposal/session expiry aborts request and clears data permanently', async () => {
  const model = new MonitoringResource();
  const pending = deferred();
  let signal;
  const load = model.load('private', s => { signal = s; return pending.promise; });
  model.clear();
  assert.equal(signal.aborted, true);
  pending.resolve({ secret: 'never-restore' }); await load;
  assert.equal(model.getSnapshot().data, null);
  assert.equal(model.getSnapshot().phase, 'idle');
});

test('monitoring view: database error clears old results and reports a safe error', async () => {
  const model = new MonitoringResource();
  await model.load('page', async () => ({ items: ['private-agent'] }));
  await model.load('page', async () => { throw new Error('sql/secret/internal'); });
  assert.equal(model.getSnapshot().phase, 'error');
  assert.equal(model.getSnapshot().data, null);
  assert.ok(!model.getSnapshot().error.includes('sql'));
});

test('monitoring view: 404 is distinct from no telemetry, stale failure cannot erase new result', async () => {
  const model = new MonitoringResource();
  await model.load('missing', async () => { throw Object.assign(new Error(), { status: 404 }); });
  assert.equal(model.getSnapshot().phase, 'missing');
  let reject;
  const old = model.load('old', () => new Promise((_, r) => { reject = r; }));
  await model.load('new', async () => ({ items: [] }));
  reject(new Error()); await old;
  assert.equal(model.getSnapshot().phase, 'ready');
  assert.deepEqual(model.getSnapshot().data, { items: [] });
});

test('monitoring view: timeout aborts stalled request, permits retry and fences late results', async () => {
  const model = new MonitoringResource();
  const pending = deferred();
  let signal;
  const load = model.load('stalled', s => { signal = s; return pending.promise; }, 10);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(model.getSnapshot().phase, 'error');
  assert.equal(signal.aborted, true);
  assert.equal(model.getSnapshot().data, null);
  await model.load('retry', async () => ({ fresh: true }));
  pending.resolve({ stale: true }); await load;
  assert.deepEqual(model.getSnapshot().data, { fresh: true });
});
