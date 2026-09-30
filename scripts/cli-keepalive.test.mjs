import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithKeepAlive } from './cli-keepalive.mjs';

test('runWithKeepAlive clears the keep-alive handle after success', async () => {
  const calls = [];
  const handle = {};
  const result = await runWithKeepAlive(async () => 'ok', {
    setIntervalFn: (callback, delay) => { calls.push(['set', callback, delay]); return handle; },
    clearIntervalFn: value => calls.push(['clear', value]),
  });
  assert.equal(result, 'ok');
  assert.equal(calls[0][0], 'set');
  assert.equal(calls[0][2], 1000);
  assert.deepEqual(calls[1], ['clear', handle]);
});

test('runWithKeepAlive clears the keep-alive handle after failure', async () => {
  const calls = [];
  const handle = {};
  await assert.rejects(() => runWithKeepAlive(async () => { throw new Error('boom'); }, {
    setIntervalFn: () => handle,
    clearIntervalFn: value => calls.push(value),
  }), /boom/);
  assert.deepEqual(calls, [handle]);
});
