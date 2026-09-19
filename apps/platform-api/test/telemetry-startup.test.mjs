import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

async function port(t, host = '127.0.0.1') {
  const server = createServer();
  await new Promise(resolve => server.listen(0, host, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { number: server.address().port, release: () => new Promise(resolve => server.close(resolve)) };
}

async function secret(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bairui-metrics-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'token');
  const token = randomBytes(32).toString('hex');
  await writeFile(path, token + '\n');
  return { path, token };
}

function child(t, env) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|temp|tmp|comspec|pathext)$/i.test(key)));
  const script = `process.on('message', () => process.emit('SIGTERM')); await import(${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)});`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...inherited, NODE_ENV: 'test', BAIRUI_PLATFORM_MODE: 'legacy', BAIRUI_AUTH_MODE: 'local',
      BAIRUI_SESSION_SECRET: 'test-only-session-secret-with-32-characters', PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  proc.stdout.on('data', data => { output += data; });
  proc.stderr.on('data', data => { output += data; });
  const exited = new Promise((resolve, reject) => { proc.once('exit', code => resolve(code)); proc.once('error', reject); });
  t.after(async () => { if (proc.exitCode === null) proc.kill(); await exited; });
  const wait = async predicate => {
    for (let count = 0; count < 120; count++) {
      if (predicate()) return;
      await delay(25);
    }
    assert.fail('API child did not reach the expected lifecycle state');
  };
  return { proc, exited, output: () => output, wait };
}

test('index emits only a safe startup event when enabled token validation fails', async t => {
  const instance = child(t, { BAIRUI_METRICS_ENABLED: '1', BAIRUI_METRICS_TOKEN_FILE: 'nonexistent-private-token-path' });
  assert.equal(await instance.exited, 1);
  const records = instance.output().trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].event, 'api_startup_error');
  assert.doesNotMatch(instance.output(), /private|Error:|\.mjs:/);
});

test('metrics bind failure prevents the public API from listening', async t => {
  // Windows can bind a wildcard alongside an existing loopback-only listener.
  const metricsPort = await port(t, '0.0.0.0');
  const apiPort = await port(t);
  const { path } = await secret(t);
  await apiPort.release();
  const instance = child(t, { PORT: String(apiPort.number), BAIRUI_METRICS_ENABLED: '1',
    BAIRUI_METRICS_PORT: String(metricsPort.number), BAIRUI_METRICS_TOKEN_FILE: path });
  await instance.wait(() => instance.proc.exitCode !== null);
  assert.equal(await instance.exited, 1);
  assert.doesNotMatch(instance.output(), /api_started|listening on/);
  await assert.rejects(fetch('http://127.0.0.1:' + apiPort.number + '/livez'));
});

test('index starts authenticated metrics before reporting API startup and closes both on shutdown', async t => {
  const metricsPort = await port(t);
  const apiPort = await port(t);
  const { path, token } = await secret(t);
  await metricsPort.release();
  await apiPort.release();
  const instance = child(t, { PORT: String(apiPort.number), BAIRUI_METRICS_ENABLED: '1',
    BAIRUI_METRICS_PORT: String(metricsPort.number), BAIRUI_METRICS_TOKEN_FILE: path });
  await instance.wait(() => instance.output().includes('api_started'));
  const metricsURL = 'http://127.0.0.1:' + metricsPort.number + '/metrics';
  assert.equal((await fetch(metricsURL)).status, 401);
  assert.equal((await fetch(metricsURL, { headers: { authorization: 'Bearer ' + token } })).status, 200);
  assert.equal((await fetch('http://127.0.0.1:' + apiPort.number + '/livez')).status, 200);
  instance.proc.send('shutdown');
  assert.equal(await instance.exited, 0);
  await assert.rejects(fetch(metricsURL));
  await assert.rejects(fetch('http://127.0.0.1:' + apiPort.number + '/livez'));
  assert.ok(!instance.output().includes(token));
});
