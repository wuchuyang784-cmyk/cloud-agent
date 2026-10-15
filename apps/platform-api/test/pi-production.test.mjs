import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, lstat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPiRuntimeService } from '../src/runtime/pi/production/service.mjs';
import { signTaskRequest, createEnvelopeVerifier } from '../src/runtime/pi/production/envelope.mjs';
import { validateConfig } from '../src/runtime/pi/production/config.mjs';

async function fixture(t, mode = 'normal', limits = {}, factoryOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-production-'));
  const paths = { workspace: join(root, 'workspace'), state: join(root, 'state'), secrets: join(root, 'secrets') };
  await Promise.all(Object.values(paths).map(p => mkdir(p)));
  const secret = randomBytes(32).toString('hex');
  await writeFile(join(paths.secrets, 'hmac'), secret);
  await writeFile(join(paths.secrets, 'gateway'), 'short-lived-fixture-token');
  const config = { agentId: 'agent_fixture', runId: randomUUID(), runGeneration: 1, sessionId: randomUUID(), provider: 'bairui-gateway', model: 'fixture-model', gatewayUrl: 'http://127.0.0.1:9876/v1', gatewayTokenFile: join(paths.secrets, 'gateway'), hmacSecretFile: join(paths.secrets, 'hmac'), listenHost: '127.0.0.1', listenPort: 0, limits: { rpcTimeoutMs: 5000, taskTimeoutMs: 1500, cancelGraceMs: 200, ...limits } };
  const options = { config, paths, executable: { command: process.execPath, args: [join(import.meta.dirname, 'helpers/pi-production-rpc.mjs'), mode] }, fixtureGatewayHosts: ['127.0.0.1'], ...factoryOptions };
  const service = await createPiRuntimeService(options);
  const address = await service.start();
  const base = `http://127.0.0.1:${address.port}`;
  const f = { root, paths, secret, config, options, service, base };
  t.after(async () => { await f.service.close(); await rm(root, { recursive: true, force: true }); });
  return f;
}
function payload(f, extra = {}) { return { agentId: f.config.agentId, runId: f.config.runId, runGeneration: f.config.runGeneration, sessionId: f.config.sessionId, taskId: randomUUID(), prompt: 'hello\nworld', ...extra }; }
async function request(f, value, target = '/v1/tasks', headers = {}) {
  const body = JSON.stringify(value);
  return fetch(f.base + target, { method: 'POST', body, headers: { ...signTaskRequest({ secret: f.secret, method: 'POST', target, body, ...f.config }), ...headers } });
}
async function waitFor(predicate, message) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail(message);
}
async function ready(f) { await waitFor(async () => (await fetch(f.base + '/readyz')).status === 200, 'never ready'); }
async function events(response) { return (await response.text()).trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); }

test('config rejects unknown keys, insecure production gateway, and unbounded limits', () => {
  assert.throws(() => validateConfig({ anything: true }), /invalid_config/);
});
test('readiness waits for actual matching RPC model and session and hides identity', async t => {
  const f = await fixture(t, 'delayed');
  const live = await fetch(f.base + '/livez');
  assert.deepEqual(await live.json(), { status: 'live' });
  assert.equal((await fetch(f.base + '/readyz')).status, 503);
  await ready(f);
  assert.deepEqual(await (await fetch(f.base + '/readyz')).json(), { status: 'ready' });
});
for (const mode of ['wrong-id', 'missing-id', 'wrong-command', 'wrong-model', 'wrong-session']) test(`readiness refuses ${mode}`, async t => {
  const f = await fixture(t, mode);
  let childPid;
  await waitFor(async () => {
    try { childPid = JSON.parse(await readFile(join(f.paths.workspace, 'ready-request.json'), 'utf8')).pid; return Number.isInteger(childPid); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'pi child did not receive get_state');
  await waitFor(() => {
    try { process.kill(childPid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'wrapper did not terminate rejected readiness handshake');
  assert.equal((await fetch(f.base + '/readyz')).status, 503);
});
test('signed tasks preserve newlines, stream ordered events and authoritative usage', async t => {
  const f = await fixture(t); await ready(f);
  const p = payload(f); const response = await request(f, p);
  assert.equal(response.status, 200);
  const e = await events(response);
  assert.deepEqual(e.map(x => x.seq), e.map((_, i) => i + 1));
  assert.equal(e[0].type, 'task.started');
  assert.equal(e.filter(x => x.type === 'message.delta').map(x => x.text).join(''), 'hello\nworld');
  assert.equal(e.at(-1).type, 'task.completed');
  assert.deepEqual(e.at(-1).usage, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 });
  assert.ok(e.some(x => x.type === 'tool.completed' && !('details' in x)));
  const stored = JSON.parse(await readFile(join(f.paths.state, 'tasks', p.taskId + '.json'), 'utf8'));
  assert.equal(stored.status, 'completed');
});
test('1.1.0 handled prompt disposition terminates without waiting for agent_settled', async t => {
  const f = await fixture(t, 'handled-prompt'); await ready(f);
  const e = await events(await request(f, payload(f)));
  assert.equal(e.at(-1).type, 'task.failed');
  assert.equal(e.at(-1).code, 'prompt_handled');
  assert.equal((await fetch(f.base + '/readyz')).status, 200);
});
test('1.1.0 queued prompt disposition waits for agent_settled', async t => {
  const f = await fixture(t, 'queued-prompt'); await ready(f);
  const e = await events(await request(f, payload(f)));
  assert.equal(e.at(-1).type, 'task.completed');
});
test('unknown 1.1.0 prompt disposition fails closed and disables readiness', async t => {
  const f = await fixture(t, 'bad-prompt-disposition'); await ready(f);
  const e = await events(await request(f, payload(f)));
  assert.equal(e.at(-1).type, 'task.failed');
  assert.equal(e.at(-1).code, 'prompt_protocol');
  assert.equal((await fetch(f.base + '/readyz')).status, 503);
});
test('unsigned, wrong tuple, extra fields, encoded target and replay are refused', async t => {
  const f = await fixture(t); await ready(f);
  const p = payload(f);
  assert.equal((await fetch(f.base + '/v1/tasks', { method: 'POST', body: JSON.stringify(p) })).status, 401);
  assert.equal((await request(f, { ...p, agentId: 'other' })).status, 403);
  assert.equal((await request(f, { ...p, extra: true })).status, 400);
  assert.equal((await request(f, p, '/v1/%74asks')).status, 404);
  const body = JSON.stringify(p), headers = signTaskRequest({ secret: f.secret, method: 'POST', target: '/v1/tasks', body, ...f.config });
  await (await request(f, p, '/v1/tasks', headers)).text();
  assert.equal((await request(f, p, '/v1/tasks', headers)).status, 401);
  for (const patch of [{ runId: randomUUID() }, { runGeneration: 2 }, { sessionId: randomUUID() }]) assert.equal((await request(f, { ...payload(f), ...patch })).status, 403);
});
test('durable UUID reservation blocks duplicate after restart and keeps persistent context', async t => {
  const f = await fixture(t); await ready(f);
  const p = payload(f);
  await (await request(f, p)).text();
  await f.service.close();
  const service = await createPiRuntimeService(f.options); const address = await service.start();
  f.service = service;
  f.base = `http://127.0.0.1:${address.port}`; await ready(f);
  assert.equal((await request(f, p)).status, 409);
  const e = await events(await request(f, payload(f, { prompt: 'context' })));
  assert.equal(e.find(x => x.type === 'message.delta').text, 'hello\nworld|context');
});
for (const mode of ['model-error', 'unknown-usage', 'multiple-usage', 'crash', 'overflow']) test(`stream handles ${mode} without false success`, async t => {
  const f = await fixture(t, mode); await ready(f);
  const e = await events(await request(f, payload(f)));
  if (mode === 'unknown-usage') assert.equal(e.at(-1).usage.totalTokens, null);
  else if (mode === 'multiple-usage') assert.equal(e.at(-1).usage.totalTokens, 20);
  else assert.equal(e.at(-1).type, 'task.failed');
  assert.ok(!JSON.stringify(e).includes('secret-error'));
});
test('busy is immediate and cancel waits settled then admits next task', async t => {
  const f = await fixture(t, 'hang'); await ready(f);
  const p = payload(f); const pending = request(f, p); await new Promise(r => setTimeout(r, 60));
  assert.equal((await request(f, payload(f))).status, 409);
  const { prompt, ...cancel } = p;
  assert.equal((await request(f, cancel, `/v1/tasks/${p.taskId}/cancel`)).status, 200);
  assert.equal((await events(await pending)).at(-1).type, 'task.cancelled');
});
test('unsettled cancellation kills child and permanently closes readiness', async t => {
  const f = await fixture(t, 'ignore-abort', { taskTimeoutMs: 150 }); await ready(f);
  const e = await events(await request(f, payload(f)));
  assert.equal(e.at(-1).type, 'task.failed');
  assert.equal((await fetch(f.base + '/readyz')).status, 503);
});
test('bounded prompt and raw request body reject before reservation', async t => {
  const f = await fixture(t); await ready(f);
  assert.equal((await request(f, payload(f, { prompt: 'x'.repeat(32769) }))).status, 413);
  assert.equal((await request(f, payload(f, { prompt: 'x'.repeat(70000) }))).status, 413);
});
test('config exact schema enforces paths, provider and finite ceilings', async t => {
  const f = await fixture(t);
  const good = { ...f.config, gatewayUrl: 'https://gateway.example/v1' };
  const opts = { paths: f.paths };
  for (const patch of [{ unknown: 1 }, { provider: 'openai' }, { gatewayUrl: 'http://remote.example/v1' }, { hmacSecretFile: join(f.paths.workspace, 'secret') }, { limits: { maxEvents: 10001 } }, { limits: { anything: 1 } }, { runGeneration: '1' }]) assert.throws(() => validateConfig({ ...good, ...patch }, opts), /invalid_config/);
  assert.equal(validateConfig(good, opts).provider, 'bairui-gateway');
});
for (const mode of ['all-zero-usage', 'no-assistant', 'duplicate-message-end']) test(`authoritative completion handles ${mode}`, async t => {
  const f = await fixture(t, mode); await ready(f);
  const e = await events(await request(f, payload(f)));
  if (mode === 'no-assistant') assert.equal(e.at(-1).type, 'task.failed');
  else if (mode === 'all-zero-usage') assert.equal(e.at(-1).usage.totalTokens, null);
  else assert.equal(e.at(-1).usage.totalTokens, 10);
});
test('malformed or future session files are refused and preserved on restart', async t => {
  const f = await fixture(t); await ready(f); await f.service.close();
  const file = join(f.paths.state, 'sessions', f.config.sessionId + '.jsonl');
  for (const content of ['not-json\n', JSON.stringify({ type: 'session', version: 99, id: randomUUID(), timestamp: new Date().toISOString(), cwd: f.paths.workspace }) + '\n', JSON.stringify({ type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: f.paths.workspace }) + '\n' + JSON.stringify({ type: 'unknown', id: 'bad', timestamp: new Date().toISOString(), parentId: null }) + '\n']) {
    await writeFile(file, content);
    await assert.rejects(async () => { const unexpected = await createPiRuntimeService(f.options); await unexpected.close(); }, /invalid_session/);
    assert.equal(await readFile(file, 'utf8'), content);
  }
});
test('1.1.0 usage and context_edit session entries are accepted on restart', async t => {
  const f = await fixture(t); await ready(f);
  await events(await request(f, payload(f)));
  await f.service.close();
  const file = join(f.paths.state, 'sessions', f.config.sessionId + '.jsonl');
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  const user = records.find(entry => entry.type === 'message' && entry.message.role === 'user');
  const parentId = records.at(-1).id;
  records.push(
    { type: 'usage', id: 'pi-usage-entry', parentId, timestamp: new Date().toISOString(), kind: 'cache_warm', provider: 'bairui-gateway', model: f.config.model, usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 } },
    { type: 'context_edit', id: 'pi-context-edit-entry', parentId: 'pi-usage-entry', timestamp: new Date().toISOString(), targetId: user.id, replacement: null },
  );
  await writeFile(file, records.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const service = await createPiRuntimeService(f.options); const address = await service.start();
  f.service = service; f.base = `http://127.0.0.1:${address.port}`; await ready(f);
  const e = await events(await request(f, payload(f, { prompt: 'after-session-upgrade' })));
  assert.equal(e.at(-1).type, 'task.completed');
});
test('output count limit cancels and does not emit completed', async t => {
  const f = await fixture(t, 'normal', { maxEvents: 3 }); await ready(f);
  assert.equal((await events(await request(f, payload(f)))).at(-1).type, 'task.failed');
});
test('terminal persistence failure never emits completed', async t => {
  const f = await fixture(t, 'slow'); await ready(f);
  const response = await request(f, payload(f));
  const original = join(f.paths.state, 'tasks');
  await rename(original, original + '-saved'); await writeFile(original, 'blocked');
  const e = await events(response);
  assert.equal(e.at(-1).type, 'task.failed'); assert.equal(e.at(-1).code, 'persistence_failed');
  assert.equal((await fetch(f.base + '/readyz')).status, 503);
});
test('HTTP stream disconnect aborts and restores idle admission after settle', async t => {
  const f = await fixture(t, 'hang'); await ready(f);
  const p = payload(f), body = JSON.stringify(p);
  await new Promise((resolve, reject) => {
    const req = httpRequest(f.base + '/v1/tasks', { method: 'POST', headers: signTaskRequest({ secret: f.secret, method: 'POST', target: '/v1/tasks', body, ...f.config }) }, res => { res.once('data', () => { res.destroy(); resolve(); }); });
    req.on('error', reject); req.end(body);
  });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(JSON.parse(await readFile(join(f.paths.state, 'tasks', p.taskId + '.json'), 'utf8')).status, 'cancelled');
  assert.equal((await fetch(f.base + '/readyz')).status, 200);
});
test('graceful shutdown aborts active task and refuses new work', async t => {
  const f = await fixture(t, 'hang'); await ready(f);
  const pending = request(f, payload(f)); await new Promise(r => setTimeout(r, 50));
  await f.service.close();
  assert.equal((await events(await pending)).at(-1).type, 'task.cancelled');
});
test('request readers are bounded and partial body has a deadline', async t => {
  const f = await fixture(t, 'normal', { maxReaders: 1, requestTimeoutMs: 150 }); await ready(f);
  let req;
  const first = new Promise((resolve, reject) => {
    req = httpRequest(f.base + '/v1/tasks', { method: 'POST', headers: { 'content-length': '100' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('{');
  });
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await request(f, payload(f))).status, 429);
  assert.equal(await first, 408); req.destroy();
});
test('single event limit cancels before forwarding an oversized event', async t => {
  const f = await fixture(t, 'normal', { maxEventBytes: 256 }); await ready(f);
  const e = await events(await request(f, payload(f, { prompt: 'x'.repeat(2000) })));
  assert.equal(e.at(-1).type, 'task.failed');
  assert.ok(!e.some(x => x.type === 'message.delta'));
});
test('late uncorrelated RPC response invalidates readiness', async t => {
  const f = await fixture(t, 'late-response'); await ready(f);
  await (await request(f, payload(f))).text();
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await fetch(f.base + '/readyz')).status, 503);
});
test('pi child sees only whitelist env and fixed discovery-disable flags', async t => {
  const previous = process.env.BAIRUI_FIXTURE_PRIVATE_SECRET;
  process.env.BAIRUI_FIXTURE_PRIVATE_SECRET = 'must-not-inherit';
  t.after(() => { if (previous === undefined) delete process.env.BAIRUI_FIXTURE_PRIVATE_SECRET; else process.env.BAIRUI_FIXTURE_PRIVATE_SECRET = previous; });
  const f = await fixture(t, 'inspect'); await ready(f);
  const e = await events(await request(f, payload(f)));
  const inspected = JSON.parse(e.find(x => x.type === 'message.delta').text);
  assert.equal(inspected.env.BAIRUI_FIXTURE_PRIVATE_SECRET, undefined);
  assert.equal(inspected.env.OPENAI_API_KEY, undefined);
  for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--offline']) assert.ok(inspected.args.includes(flag));
  for (const [flag, value] of [['--mode', 'rpc'], ['--provider', f.config.provider], ['--model', f.config.model], ['--session-dir', join(f.paths.state, 'sessions')]]) {
    const index = inspected.args.indexOf(flag);
    assert.ok(index >= 0 && inspected.args[index + 1] === value, flag + '_argv_mismatch');
  }
  assert.equal(inspected.args[inspected.args.indexOf('--session') + 1], join(f.paths.state, 'sessions', f.config.sessionId + '.jsonl'));
  assert.equal(inspected.env.PI_CODING_AGENT_DIR, join(f.paths.state, 'trusted-config'));
});
test('secret symlink and malformed low-entropy secret are refused', async t => {
  const f = await fixture(t); await f.service.close();
  await writeFile(f.config.hmacSecretFile, 'a'.repeat(64));
  await assert.rejects(createPiRuntimeService(f.options), /invalid_secret/);
  await writeFile(f.config.hmacSecretFile, f.secret);
  const target = join(f.paths.secrets, 'other-secret'); await rename(f.config.hmacSecretFile, target);
  try { await symlink(target, f.config.hmacSecretFile); } catch (e) { if (e.code === 'EPERM') return; throw e; }
  await assert.rejects(createPiRuntimeService(f.options), /invalid_file/);
});
test('future-skew signed nonce remains spent for the entire signature acceptance window', t => {
  const secret = randomBytes(32).toString('hex');
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const config = { agentId: 'agent', runId: randomUUID(), runGeneration: 1, limits: { nonceTtlMs: 60000, maxNonces: 10 } };
  const verify = createEnvelopeVerifier(config, secret, { now: () => now });
  const body = '{}';
  const headers = signTaskRequest({ secret, method: 'POST', target: '/v1/tasks', body, timestamp: String(now + 59000), ...config });
  const req = { method: 'POST', url: '/v1/tasks', headers };
  assert.equal(verify(req, body), true);
  now += 60001;
  assert.equal(verify(req, body), false);
});
test('tool projections exclude raw output, paths, errors, and secret echoes', async t => {
  const f = await fixture(t, 'tool-error'); await ready(f);
  const e = await events(await request(f, payload(f)));
  const projected = e.filter(x => x.type.startsWith('tool.'));
  assert.ok(projected.some(x => x.type === 'tool.completed' && x.isError));
  const text = JSON.stringify(projected);
  for (const sensitive of ['/private/internal', 'raw-tool-error', f.secret, 'short-lived-fixture-token']) assert.ok(!text.includes(sensitive));
  assert.ok(projected.every(x => !('text' in x) && !('args' in x) && !('details' in x)));
});
test('known run secret and gateway token are redacted across assistant delta boundaries', async t => {
  const f = await fixture(t, 'secret-deltas'); await ready(f);
  const e = await events(await request(f, payload(f)));
  const text = e.filter(x => x.type === 'message.delta').map(x => x.text).join('');
  assert.ok(!text.includes(f.secret)); assert.ok(!text.includes('short-lived-fixture-token'));
  assert.equal(text, 'before [redacted] middle [redacted] after');
});
test('known secret redaction retains suffix across assistant message boundaries', async t => {
  const f = await fixture(t, 'cross-message-secret'); await ready(f);
  const e = await events(await request(f, payload(f)));
  const text = e.filter(x => x.type === 'message.delta').map(x => x.text).join('');
  assert.equal(text, 'before [redacted] after');
});
test('cancellation during durable reservation finishes cancelled without dispatching prompt', async t => {
  let reached, release;
  const reachedGate = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, 'record-commands', {}, { dispatchGate: async () => { reached(); await gate; } }); await ready(f);
  const p = payload(f), pending = request(f, p);
  let waitTimer;
  try { await Promise.race([reachedGate, new Promise((_, reject) => { waitTimer = setTimeout(() => reject(new Error('reservation_gate_not_reached')), 1000); })]); } finally { clearTimeout(waitTimer); }
  const { prompt, ...value } = p;
  assert.equal((await request(f, value, `/v1/tasks/${p.taskId}/cancel`)).status, 200);
  assert.equal((await request(f, value, `/v1/tasks/${p.taskId}/cancel`)).status, 200);
  release();
  const e = await events(await pending);
  assert.equal(e.at(-1).type, 'task.cancelled');
  const commands = (await readFile(join(f.paths.workspace, 'commands.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!commands.includes('prompt')); assert.ok(!commands.includes('abort'));
  assert.equal(JSON.parse(await readFile(join(f.paths.state, 'tasks', p.taskId + '.json'), 'utf8')).status, 'cancelled');
});
test('total raw RPC bytes are bounded even when legal frames are omitted from projection', async t => {
  const f = await fixture(t, 'raw-flood', { maxRawRpcBytes: 200000 }); await ready(f);
  const p = payload(f);
  const e = await events(await request(f, p));
  assert.equal(e.at(-1).type, 'task.failed');
  assert.equal((await fetch(f.base + '/readyz')).status, 503);
  assert.equal(JSON.parse(await readFile(join(f.paths.state, 'tasks', p.taskId + '.json'), 'utf8')).status, 'unknown');
});
test('paused HTTP consumer leaves no active unbounded task or success', async t => {
  const f = await fixture(t, 'output-flood', { maxClientBufferBytes: 16384, maxEventBytes: 32768, requestTimeoutMs: 100, taskTimeoutMs: 800 }); await ready(f);
  const p = payload(f), body = JSON.stringify(p);
  let req, response;
  await new Promise((resolve, reject) => {
    req = httpRequest(f.base + '/v1/tasks', { method: 'POST', headers: signTaskRequest({ secret: f.secret, method: 'POST', target: '/v1/tasks', body, ...f.config }) }, res => { response = res; res.pause(); resolve(); });
    req.on('error', reject); req.end(body);
  });
  let stored;
  try {
    const ledgerFile = join(f.paths.state, 'tasks', p.taskId + '.json');
    const reservedBytes = Buffer.byteLength(JSON.stringify({ taskId: p.taskId, sessionId: f.config.sessionId, agentId: f.config.agentId, runId: f.config.runId, runGeneration: f.config.runGeneration, status: 'unknown', terminal: false }));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      // Opening the target repeatedly can make Windows atomic replacement fail with EPERM.
      // Every terminal status has a different size from the immutable reservation.
      if ((await lstat(ledgerFile)).size !== reservedBytes) {
        stored = JSON.parse(await readFile(ledgerFile, 'utf8'));
        if (stored.terminal) break;
      }
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.equal(stored?.terminal, true, 'terminal status must persist while consumer is still paused');
    assert.ok(['failed', 'unknown'].includes(stored.status));
  } finally { response.destroy(); req.destroy(); }
});
test('RPC fixture is inert when test discovery imports it without explicit argv', async () => {
  const result = await promisify(execFile)(process.execPath, [join(import.meta.dirname, 'helpers/pi-production-rpc.mjs')], { timeout: 1000 });
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});
test('existing ledger run-UUID identity is accepted and preserved exactly', async t => {
  const f = await fixture(t); await f.service.close();
  f.config.runId = 'run-' + randomUUID();
  f.options.config = f.config;
  for (const runId of ['run-not-a-uuid', f.config.runId + '-suffix', 'run-' + f.config.runId]) assert.throws(() => validateConfig({ ...f.config, runId }, { paths: f.paths, fixtureGatewayHosts: ['127.0.0.1'] }), /invalid_config/);
  f.service = await createPiRuntimeService(f.options);
  const address = await f.service.start(); f.base = `http://127.0.0.1:${address.port}`; await ready(f);
  const p = payload(f); assert.equal((await events(await request(f, p))).at(-1).type, 'task.completed');
  const stored = JSON.parse(await readFile(join(f.paths.state, 'tasks', p.taskId + '.json'), 'utf8'));
  assert.equal(stored.runId, f.config.runId);
  assert.equal((await request(f, payload(f, { runId: f.config.runId.slice(4) }))).status, 403);
});
