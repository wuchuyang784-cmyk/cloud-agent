import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open as openFile, readFile, writeFile, rm, chmod, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openSandboxState } from '../src/runtime/pi/sandbox/state.mjs';

const initial = () => ({ organizationId: 'org-one', ownerUserId: 'user-one', agentId: 'agent-one',
  runId: `run-${randomUUID()}`, runGeneration: 1, sessionId: randomUUID() });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-protected-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, 'trusted'), identity: initial() };
}
async function open(t, fixture, identity = fixture.identity) {
  const state = await openSandboxState({ directory: fixture.directory, identity });
  t.after(() => state.close());
  return state;
}
const reserve = (state, identity, taskId = randomUUID()) => state.reserve({ taskId, sessionId: identity.sessionId });
const stopped = (state, identity) => state.confirmStopped({ runId: identity.runId,
  runGeneration: identity.runGeneration, sandboxAbsent: true, controlAbsent: true });

test('Linux first initialization syncs the parent entry before admission and reopens leave it alone',
  { skip: process.platform !== 'linux' ? 'Linux directory fsync contract only' : false }, async t => {
    const f = await fixture(t); const parent = await openFile(f.root, 'r');
    const parentInfo = await parent.stat(); const prototype = Object.getPrototypeOf(parent);
    const originalSync = prototype.sync; await parent.close();
    const events = [];
    t.mock.method(prototype, 'sync', async function () {
      const info = await this.stat(); const isParent = info.dev === parentInfo.dev && info.ino === parentInfo.ino;
      if (isParent) events.push('parent-sync-start');
      const result = await originalSync.call(this);
      if (isParent) events.push('parent-sync-complete');
      return result;
    });
    const state = await open(t, f); events.push('open-admitted');
    assert.deepEqual(events, ['parent-sync-start', 'parent-sync-complete', 'open-admitted']);
    await reserve(state, f.identity); await state.close(); const reopened = await open(t, f); await reopened.close();
    assert.deepEqual(events, ['parent-sync-start', 'parent-sync-complete', 'open-admitted']);
  });

test('Linux parent fsync failure rejects initialization without admitting a writer or leaking paths',
  { skip: process.platform !== 'linux' ? 'Linux directory fsync failure contract only' : false }, async t => {
    const f = await fixture(t); const parent = await openFile(f.root, 'r');
    const parentInfo = await parent.stat(); const prototype = Object.getPrototypeOf(parent);
    const originalSync = prototype.sync; await parent.close(); let parentCalls = 0;
    t.mock.method(prototype, 'sync', async function () {
      const info = await this.stat();
      if (info.dev === parentInfo.dev && info.ino === parentInfo.ino) {
        parentCalls += 1; throw Object.assign(new Error(`Parent fsync failed: ${f.root}`), { code: 'EIO' });
      }
      return originalSync.call(this);
    });
    await assert.rejects(open(t, f), error => error.code === 'SANDBOX_STATE_UNAVAILABLE'
      && !error.message.includes(f.root));
    assert.equal(parentCalls, 1);
  });

test('persists reservation before return and serializes concurrent duplicate reservations', async t => {
  const f = await fixture(t); const state = await open(t, f); const taskId = randomUUID();
  const results = await Promise.allSettled([reserve(state, f.identity, taskId), reserve(state, f.identity, taskId)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const disk = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8'));
  assert.equal(disk.tasks[0].taskId, taskId); assert.equal(disk.tasks[0].status, 'unknown');
  assert.equal(disk.tasks[0].terminal, false);
});

test('task dedup survives close, recovery and a strictly newer stopped run', async t => {
  const f = await fixture(t); let state = await open(t, f); const taskId = randomUUID();
  await reserve(state, f.identity, taskId); await state.close();
  state = await open(t, f); await assert.rejects(reserve(state, f.identity, taskId));
  await state.beginStop(); await stopped(state, f.identity); await state.close();
  const next = { ...f.identity, runId: randomUUID(), runGeneration: 2, sessionId: randomUUID() };
  state = await open(t, f, next); await assert.rejects(reserve(state, next, taskId));
  await reserve(state, next); assert.equal(state.snapshot().runs.length, 2);
});

test('refuses owner, current generation, session and premature new run mismatches', async t => {
  const f = await fixture(t); const state = await open(t, f); await state.close();
  for (const patch of [{ organizationId: 'else' }, { ownerUserId: 'else' }, { agentId: 'else' },
    { runGeneration: 2 }, { sessionId: randomUUID() }, { runId: randomUUID(), runGeneration: 2 }]) {
    await assert.rejects(openSandboxState({ directory: f.directory, identity: { ...f.identity, ...patch } }));
  }
  await open(t, f);
});

test('stopping is permanent and only confirmed stop permits an increasing generation', async t => {
  const f = await fixture(t); let state = await open(t, f); await state.beginStop();
  await assert.rejects(reserve(state, f.identity)); await state.close();
  state = await open(t, f); await assert.rejects(reserve(state, f.identity));
  await stopped(state, f.identity); await state.close();
  await assert.rejects(openSandboxState({ directory: f.directory,
    identity: { ...f.identity, runId: randomUUID() } }));
  const next = { ...f.identity, runId: randomUUID(), runGeneration: 2 };
  state = await open(t, f, next); await state.beginStop(); await stopped(state, next); await state.close();
  await assert.rejects(openSandboxState({ directory: f.directory, identity: { ...f.identity, runGeneration: 3 } }));
});

test('snapshots are deeply immutable detached copies without disk paths', async t => {
  const f = await fixture(t); const state = await open(t, f); await reserve(state, f.identity);
  const snapshot = state.snapshot(); assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.tasks)); assert.ok(Object.isFrozen(snapshot.tasks[0]));
  assert.throws(() => { snapshot.tasks[0].status = 'completed'; });
  assert.equal(JSON.stringify(snapshot).includes(f.directory), false);
  assert.equal(state.snapshot().tasks[0].status, 'unknown');
});

test('terminal results cannot be changed, including an explicit unknown finish', async t => {
  const f = await fixture(t); const state = await open(t, f);
  for (const status of ['completed', 'failed', 'cancelled', 'unknown']) {
    const taskId = randomUUID(); await reserve(state, f.identity, taskId); await state.finish(taskId, status);
    await assert.rejects(state.finish(taskId, status)); await assert.rejects(state.finish(taskId, 'completed'));
  }
  await assert.rejects(state.finish(randomUUID(), 'completed'));
  assert.ok(state.snapshot().tasks.every(task => task.terminal));
});

test('finish belongs to the current run and remains available while stopping', async t => {
  const f = await fixture(t); let state = await open(t, f); const taskId = randomUUID();
  await reserve(state, f.identity, taskId); await state.beginStop(); await state.finish(taskId, 'failed');
  await stopped(state, f.identity); await state.close();
  const next = { ...f.identity, runId: randomUUID(), runGeneration: 2 };
  state = await open(t, f, next); await assert.rejects(state.finish(taskId, 'completed'));
});

test('stop confirmation requires stopping, the exact run, and both absence assertions', async t => {
  const f = await fixture(t); const state = await open(t, f);
  await assert.rejects(stopped(state, f.identity)); await state.beginStop();
  const proof = { runId: f.identity.runId, runGeneration: 1, sandboxAbsent: true, controlAbsent: true };
  for (const patch of [{ runId: randomUUID() }, { runGeneration: 2 }, { sandboxAbsent: false },
    { controlAbsent: false }, { controlAbsent: null }, { other: true }]) {
    await assert.rejects(state.confirmStopped({ ...proof, ...patch }));
  }
  const { controlAbsent, ...partial } = proof; await assert.rejects(state.confirmStopped(partial));
  await stopped(state, f.identity); assert.equal(state.snapshot().runs[0].state, 'stopped');
});

test('concurrent writes retain all tasks and close drains already queued operations', async t => {
  const f = await fixture(t); const state = await open(t, f);
  const tasks = Array.from({ length: 30 }, () => randomUUID());
  const operations = tasks.map(task => reserve(state, f.identity, task)); const closing = state.close();
  await Promise.all(operations); await closing; await state.close();
  await assert.rejects(reserve(state, f.identity));
  const reopened = await open(t, f); assert.equal(reopened.snapshot().tasks.length, tasks.length);
});

test('writer lock excludes a second instance and is released by its owner', async t => {
  const f = await fixture(t); const state = await open(t, f);
  await assert.rejects(openSandboxState({ directory: f.directory, identity: f.identity }));
  await reserve(state, f.identity); await state.close(); await open(t, f);
});

test('concurrent first opens have exactly one winner and leave a reopenable ledger', async t => {
  let incorrectWinnerCount = 0; let failedRecoveryCount = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const f = await fixture(t); const options = { directory: f.directory, identity: f.identity };
    const results = await Promise.allSettled([openSandboxState(options), openSandboxState(options)]);
    const winners = results.filter(result => result.status === 'fulfilled');
    if (winners.length !== 1) incorrectWinnerCount += 1;
    await Promise.all(winners.map(result => result.value.close()));
    try { const recovered = await openSandboxState(options); await recovered.close(); }
    catch { failedRecoveryCount += 1; }
  }
  assert.deepEqual({ incorrectWinnerCount, failedRecoveryCount },
    { incorrectWinnerCount: 0, failedRecoveryCount: 0 });
});

test('a second process cannot acquire a live writer lock', async t => {
  const f = await fixture(t); await open(t, f);
  const source = `import { openSandboxState } from ${JSON.stringify(new URL('../src/runtime/pi/sandbox/state.mjs', import.meta.url).href)};\ntry { await openSandboxState(${JSON.stringify({ directory: f.directory, identity: f.identity })}); process.exitCode=3; } catch { process.exitCode=0; }`;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
    child.once('error', reject); child.once('exit', resolve);
  });
  assert.equal(code, 0);
});

test('an abandoned lock is never automatically removed or taken over', async t => {
  const f = await fixture(t); await mkdir(f.directory, { mode: 0o700 });
  const lock = path.join(f.directory, 'writer.lock'); await writeFile(lock, 'abandoned', { mode: 0o600 });
  await assert.rejects(openSandboxState({ directory: f.directory, identity: f.identity }));
  assert.equal(await readFile(lock, 'utf8'), 'abandoned');
});

test('an existing directory with missing ledger never initializes an empty replayable history', async t => {
  const f = await fixture(t); await mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(openSandboxState({ directory: f.directory, identity: f.identity }));
  await assert.rejects(readFile(path.join(f.directory, 'state.json')));
  const fresh = await fixture(t); const state = await open(t, fresh); await reserve(state, fresh.identity);
  await state.close(); await rm(path.join(fresh.directory, 'state.json'));
  await assert.rejects(openSandboxState({ directory: fresh.directory, identity: fresh.identity }));
  await assert.rejects(readFile(path.join(fresh.directory, 'state.json')));
});

test('close preserves a lock whose nonce was modified in place', async t => {
  const f = await fixture(t); const state = await open(t, f);
  const file = path.join(f.directory, 'writer.lock'); await writeFile(file, 'another-owner', { mode: 0o600 });
  await state.close(); assert.equal(await readFile(file, 'utf8'), 'another-owner');
});

test('all identity and task UUID strings reject trailing control characters', async t => {
  const f = await fixture(t);
  for (const key of ['organizationId', 'ownerUserId', 'agentId', 'runId', 'sessionId']) {
    await assert.rejects(openSandboxState({ directory: f.directory, identity: { ...f.identity, [key]: `${f.identity[key]}\n` } }));
  }
  const state = await open(t, f);
  await assert.rejects(reserve(state, f.identity, `${randomUUID()}\n`));
});

test('reopen rejects corrupt, unknown-schema and oversized ledgers without changing them', async t => {
  for (const value of ['{', JSON.stringify({ schemaVersion: 99 }), 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    const f = await fixture(t); const state = await open(t, f); await state.close();
    const file = path.join(f.directory, 'state.json'); await writeFile(file, value, { mode: 0o600 });
    await assert.rejects(openSandboxState({ directory: f.directory, identity: f.identity }));
    assert.equal(await readFile(file, 'utf8'), value);
  }
});

test('reopen validates all historical tasks and run records', async t => {
  const f = await fixture(t); const state = await open(t, f); await reserve(state, f.identity); await state.close();
  const file = path.join(f.directory, 'state.json'); const disk = JSON.parse(await readFile(file, 'utf8'));
  for (const mutation of [value => { value.tasks[0].terminal = 'yes'; },
    value => { value.tasks[0].runId = randomUUID(); }, value => { value.runs[0].extra = true; },
    value => { value.tasks.push({ ...value.tasks[0] }); }]) {
    const bad = structuredClone(disk); mutation(bad); await writeFile(file, JSON.stringify(bad), { mode: 0o600 });
    await assert.rejects(openSandboxState({ directory: f.directory, identity: f.identity }));
  }
});

test('full task history refuses new reservations but permits finishing and stopping', async t => {
  const f = await fixture(t); let state = await open(t, f); await state.close();
  const file = path.join(f.directory, 'state.json'); const disk = JSON.parse(await readFile(file, 'utf8'));
  disk.tasks = Array.from({ length: 4096 }, () => ({ taskId: randomUUID(), runId: f.identity.runId,
    runGeneration: 1, sessionId: f.identity.sessionId, status: 'unknown', terminal: false }));
  await writeFile(file, JSON.stringify(disk), { mode: 0o600 });
  state = await open(t, f); await assert.rejects(reserve(state, f.identity));
  await state.finish(disk.tasks[0].taskId, 'completed'); await state.beginStop(); await stopped(state, f.identity);
  assert.equal(state.snapshot().tasks.length, 4096);
});

test('full run history is retained and refuses another generation', async t => {
  const f = await fixture(t); const state = await open(t, f); await state.close();
  const file = path.join(f.directory, 'state.json'); const disk = JSON.parse(await readFile(file, 'utf8'));
  disk.runs = Array.from({ length: 256 }, (_, index) => ({ runId: randomUUID(), runGeneration: index + 1,
    sessionId: randomUUID(), state: 'stopped' }));
  await writeFile(file, JSON.stringify(disk), { mode: 0o600 });
  const current = disk.runs.at(-1); const currentIdentity = { ...f.identity,
    runId: current.runId, runGeneration: current.runGeneration, sessionId: current.sessionId };
  const reopened = await open(t, f, currentIdentity); await assert.rejects(reserve(reopened, currentIdentity));
  await reopened.close();
  await assert.rejects(openSandboxState({ directory: f.directory,
    identity: { ...currentIdentity, runId: randomUUID(), runGeneration: 257 } }));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).runs.length, 256);
});

test('beginStop denies a reservation queued immediately after it', async t => {
  const f = await fixture(t); const state = await open(t, f);
  const stopping = state.beginStop(); const reservation = reserve(state, f.identity);
  await stopping; await assert.rejects(reservation); assert.equal(state.snapshot().tasks.length, 0);
});

test('rejects symlink state directories and symlink ledger files', async t => {
  const f = await fixture(t); const actual = path.join(f.root, 'actual'); await mkdir(actual, { mode: 0o700 });
  try { await symlink(actual, f.directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  await assert.rejects(openSandboxState({ directory: f.directory, identity: f.identity }));
  await rm(f.directory); await mkdir(f.directory, { mode: 0o700 });
  const target = path.join(actual, 'outside.json'); await writeFile(target, '{}', { mode: 0o600 });
  try { await symlink(target, path.join(f.directory, 'state.json')); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows file symlink privilege unavailable'); throw error; }
  await assert.rejects(openSandboxState({ directory: f.directory, identity: f.identity }));
  assert.equal(await readFile(target, 'utf8'), '{}');
});

test('POSIX directory and state files must remain private', { skip: process.platform === 'win32' ? 'Windows has no POSIX permission claim' : false }, async t => {
  const f = await fixture(t); const state = await open(t, f); await state.close();
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.directory, 'state.json'))).mode & 0o777, 0o600);
  await chmod(f.directory, 0o755); await assert.rejects(openSandboxState({ directory: f.directory, identity: f.identity }));
  await chmod(f.directory, 0o700); await chmod(path.join(f.directory, 'state.json'), 0o644);
  await assert.rejects(openSandboxState({ directory: f.directory, identity: f.identity }));
});

test('real persistence failure poisons the writer and never reports a completed task', async t => {
  const f = await fixture(t); const state = await open(t, f); const taskId = randomUUID();
  await reserve(state, f.identity, taskId); const file = path.join(f.directory, 'state.json');
  await rm(file); await mkdir(file);
  await assert.rejects(state.finish(taskId, 'completed'), error => !error.message.includes(f.directory));
  assert.equal(state.snapshot().tasks[0].status, 'unknown');
  await rm(file, { recursive: true });
  await assert.rejects(reserve(state, f.identity)); await assert.rejects(state.beginStop());
});

test('rejects directory replacement before persisting and does not delete another writer lock', async t => {
  const f = await fixture(t); const state = await open(t, f);
  await rm(f.directory, { recursive: true }); await mkdir(f.directory, { mode: 0o700 });
  const replacement = path.join(f.directory, 'writer.lock'); await writeFile(replacement, 'someone-else', { mode: 0o600 });
  await assert.rejects(reserve(state, f.identity)); await state.close();
  assert.equal(await readFile(replacement, 'utf8'), 'someone-else');
});

test('validates exact arguments without invoking accessors or proxy traps', async t => {
  const f = await fixture(t); let invoked = false;
  const accessor = { ...f.identity }; Object.defineProperty(accessor, 'runId', { enumerable: true, get() { invoked = true; throw new Error('secret'); } });
  const proxy = new Proxy(f.identity, { ownKeys() { invoked = true; throw new Error('secret'); } });
  for (const identity of [accessor, proxy, { ...f.identity, extra: true }, { ...f.identity, agentId: 'bad\nvalue' },
    { ...f.identity, runId: 'bad' }, { ...f.identity, runGeneration: 0 }]) {
    await assert.rejects(openSandboxState({ directory: f.directory, identity }), error => !error.message.includes('secret'));
  }
  assert.equal(invoked, false); const state = await open(t, f);
  await assert.rejects(state.reserve({ taskId: randomUUID(), sessionId: randomUUID() }));
  await assert.rejects(state.reserve({ taskId: randomUUID(), sessionId: f.identity.sessionId, extra: true }));
  await assert.rejects(state.finish(randomUUID(), 'success'));
  await assert.rejects(openSandboxState({ directory: f.directory, identity: f.identity, extra: true }));
});

// This portable state-library suite does not test native quotas, runsc, or Docker absence discovery.
