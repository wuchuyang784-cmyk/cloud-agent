import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceArgs, gatewayConfig, summarizeSamples, authRetryDelay } from './swarm-scheduler-config.mjs';

test('check services have two replicas, constrained resources, secrets and no published ports', () => {
  for (const role of ['api', 'worker']) {
    const args = serviceArgs({ name: 'check-' + role, image: 'check:local', network: 'check-net', secret: 'check-secret', config: 'check-code', role });
    const value = key => args[args.indexOf(key) + 1];
    assert.equal(value('--replicas'), '2');
    assert.equal(value('--limit-memory'), role === 'api' ? '384M' : '256M');
    assert.equal(value('--reserve-memory'), '64M');
    assert.equal(value('--user'), '1000:1000');
    assert.match(value('--secret'), /uid=1000.*mode=0400/);
    assert.ok(!args.some(s => /DATABASE_URL|docker.sock|--publish/.test(s)));
    assert.deepEqual(args.slice(-3), ['check:local', 'node', '/app/scheduler-check-entrypoint.mjs']);
  }
});

test('gateway routes only authentication and simulation, and does not pin API connections', () => {
  const config = gatewayConfig('check-api');
  assert.ok(config.includes('/api/auth/*'));
  assert.ok(config.includes('/api/simulation/tasks*'));
  assert.match(config, /keepalive off/);
  assert.match(config, /dynamic a/);
  assert.match(config, /name tasks\.check-api/);
  assert.match(config, /lb_policy round_robin/);
  assert.doesNotMatch(config, /reverse_proxy check-api:8080/);
  assert.match(config, /respond 404/);
  assert.doesNotMatch(config, /agent|recharge/);
});

test('samples reject violated concurrency limits and report observed peaks', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ status: 'running', user_id: 'u' + i, workerId: 'w' + i % 2 }));
  assert.deepEqual(summarizeSamples([rows, []]), { samples: 2, peakRunning: 10, peakUser: 1, peakWorker: 5 });
  assert.throws(() => summarizeSamples([[...rows, rows[0]]]), /global_concurrency/);
  assert.throws(() => summarizeSamples([rows.slice(0, 6).map(t => ({ ...t, user_id: 'same' }))]), /user_concurrency/);
  assert.throws(() => summarizeSamples([rows.slice(0, 6).map(t => ({ ...t, workerId: 'same' }))]), /worker_concurrency/);
});

test('only auth fixture creation retries 429 with bounded Retry-After', () => {
  assert.equal(authRetryDelay('/api/auth/sign-up/email', 429, '8', 0), 8250);
  assert.equal(authRetryDelay('/api/auth/sign-in/email', 429, '10', 1), 10250);
  assert.equal(authRetryDelay('/api/auth/sign-up/email', 429, null, 0), 10250);
  assert.equal(authRetryDelay('/api/auth/sign-up/email', 429, '999', 0), null);
  assert.equal(authRetryDelay('/api/auth/sign-up/email', 429, '2', 3), null);
  assert.equal(authRetryDelay('/api/simulation/tasks', 429, '2', 0), null);
  assert.equal(authRetryDelay('/api/auth/sign-up/email', 500, '2', 0), null);
});
