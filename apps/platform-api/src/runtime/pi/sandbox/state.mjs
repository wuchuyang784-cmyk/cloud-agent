import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { types } from 'node:util';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TASKS = 4096;
const MAX_RUNS = 256;
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const RUN_ID = new RegExp(`^(?:run-)?${UUID_SOURCE}$`);
const IDENTITY_KEYS = ['organizationId', 'ownerUserId', 'agentId', 'runId', 'runGeneration', 'sessionId'];
const OWNER_KEYS = ['organizationId', 'ownerUserId', 'agentId'];
const RUN_KEYS = ['runId', 'runGeneration', 'sessionId', 'state'];
const TASK_KEYS = ['taskId', 'runId', 'runGeneration', 'sessionId', 'status', 'terminal'];
const STATUSES = ['completed', 'failed', 'cancelled', 'unknown'];
const NOFOLLOW = constants.O_NOFOLLOW || 0;

function reject(code = 'INVALID') {
  const error = new Error('Sandbox state operation rejected');
  error.code = `SANDBOX_STATE_${code}`;
  throw error;
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) reject();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) reject();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
  }
}

const cleanString = value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value);
const isUuid = value => cleanString(value) && UUID.test(value);
const isRunId = value => cleanString(value) && RUN_ID.test(value);
const isGeneration = value => Number.isSafeInteger(value) && value > 0;
const safeId = value => cleanString(value) && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value);
const sameFile = (first, second) => first.dev === second.dev && first.ino === second.ino;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const lastRun = ledger => ledger.runs.at(-1);

function validateIdentity(identity) {
  exact(identity, IDENTITY_KEYS);
  if (!OWNER_KEYS.every(key => safeId(identity[key])) || !isRunId(identity.runId)
    || !isGeneration(identity.runGeneration) || !isUuid(identity.sessionId)) reject();
  return { ...identity };
}

function validateLedger(ledger) {
  exact(ledger, ['schemaVersion', 'owner', 'runs', 'tasks']);
  exact(ledger.owner, OWNER_KEYS);
  if (ledger.schemaVersion !== 1 || !OWNER_KEYS.every(key => safeId(ledger.owner[key]))
    || !Array.isArray(ledger.runs) || !ledger.runs.length || ledger.runs.length > MAX_RUNS
    || !Array.isArray(ledger.tasks) || ledger.tasks.length > MAX_TASKS) reject();
  const runs = new Map();
  let previous;
  for (const run of ledger.runs) {
    exact(run, RUN_KEYS);
    if (!isRunId(run.runId) || !isGeneration(run.runGeneration) || !isUuid(run.sessionId)
      || !['active', 'stopping', 'stopped'].includes(run.state) || runs.has(run.runId)
      || (previous && (previous.state !== 'stopped' || previous.runGeneration >= run.runGeneration))) reject();
    runs.set(run.runId, run); previous = run;
  }
  const tasks = new Set();
  for (const task of ledger.tasks) {
    exact(task, TASK_KEYS);
    const run = runs.get(task.runId);
    if (!isUuid(task.taskId) || tasks.has(task.taskId) || !run
      || task.runGeneration !== run.runGeneration || task.sessionId !== run.sessionId
      || !STATUSES.includes(task.status) || typeof task.terminal !== 'boolean'
      || (!task.terminal && task.status !== 'unknown')) reject();
    tasks.add(task.taskId);
  }
}

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

function privateStat(info, directory = false) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || (!directory && info.nlink !== 1)) reject('UNAVAILABLE');
  if (process.platform !== 'win32'
    && ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()))) {
    reject('UNAVAILABLE');
  }
}

async function readProtected(file) {
  const before = await lstat(file); privateStat(before);
  if (before.size > MAX_BYTES) reject('UNAVAILABLE');
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat(); privateStat(info);
    if (!sameFile(before, info) || info.size > MAX_BYTES) reject('UNAVAILABLE');
    // Read one byte beyond the observed length to detect growth without reserving
    // the entire ledger limit for each tiny writer-lock verification.
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat(); const named = await lstat(file);
    privateStat(after); privateStat(named);
    if (offset > MAX_BYTES || after.size !== offset || !sameFile(info, named)
      || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) reject('UNAVAILABLE');
    return { bytes: buffer.subarray(0, offset), info };
  } finally { await handle.close(); }
}

/**
 * Open the caller's explicit protected trusted-state directory, never a workload workspace.
 * This library records trusted stop assertions; it does not discover Docker/native absence.
 * A leftover writer.lock requires separate operator recovery and is never taken over here.
 */
export async function openSandboxState(options) {
  let directory; let identity;
  try {
    exact(options, ['directory', 'identity']);
    identity = validateIdentity(options.identity);
    if (typeof options.directory !== 'string' || options.directory.length > 2048
      || /[\x00-\x1f\x7f]/.test(options.directory) || !path.isAbsolute(options.directory)) reject();
    directory = path.resolve(options.directory);
  } catch { reject(); }

  const file = path.join(directory, 'state.json');
  const lockFile = path.join(directory, 'writer.lock');
  const token = randomUUID();
  let directoryInfo; let lockHandle; let lockInfo; let ledger; let diskDigest = null; let createdDirectory = false;
  let poisoned = false; let closing = false; let closePromise; let queue = Promise.resolve();
  const temporaryFiles = new Map();

  async function checkDirectory() {
    const info = await lstat(directory); privateStat(info, true);
    if (!sameFile(info, directoryInfo) || path.resolve(await realpath(directory)) !== directory) reject('UNAVAILABLE');
  }

  async function checkLock() {
    await checkDirectory();
    const named = await lstat(lockFile); privateStat(named);
    if (!sameFile(named, lockInfo) || !sameFile(await lockHandle.stat(), lockInfo)) reject('UNAVAILABLE');
    const lock = await readProtected(lockFile);
    if (!sameFile(lock.info, lockInfo) || lock.bytes.toString('utf8') !== token) reject('UNAVAILABLE');
  }

  async function checkLedger() {
    if (diskDigest === null) {
      try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      reject('UNAVAILABLE');
    }
    const current = await readProtected(file);
    if (digest(current.bytes) !== diskDigest) reject('UNAVAILABLE');
  }

  async function syncDirectory() {
    if (process.platform !== 'linux') return;
    const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | NOFOLLOW);
    try {
      if (!sameFile(await handle.stat(), directoryInfo)) reject('UNAVAILABLE');
      await handle.sync();
    } finally { await handle.close(); }
  }

  async function syncCreatedDirectoryEntry() {
    if (process.platform !== 'linux' || !createdDirectory) return;
    const parentDirectory = path.dirname(directory);
    const parentInfo = await lstat(parentDirectory);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()
      || path.resolve(await realpath(parentDirectory)) !== parentDirectory) reject('UNAVAILABLE');
    const handle = await open(parentDirectory, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW);
    try {
      if (!sameFile(await handle.stat(), parentInfo)) reject('UNAVAILABLE');
      await checkDirectory();
      // Syncing state.json and its directory does not persist the new directory's
      // entry in its parent. Complete that barrier before admitting this writer.
      await handle.sync();
      const namedParent = await lstat(parentDirectory);
      if (!namedParent.isDirectory() || namedParent.isSymbolicLink() || !sameFile(namedParent, parentInfo)
        || path.resolve(await realpath(parentDirectory)) !== parentDirectory) reject('UNAVAILABLE');
      await checkDirectory();
    } finally { await handle.close(); }
  }

  async function removeOwned(filePath, info) {
    // Re-check both the directory and inode. Never clean up an unrelated replacement.
    try {
      await checkDirectory();
      const named = await lstat(filePath);
      if (sameFile(named, info) && !named.isSymbolicLink()) await unlink(filePath);
    } catch { /* Missing or replaced paths are left for explicit recovery. */ }
  }

  async function release() {
    for (const [temporary, info] of temporaryFiles) await removeOwned(temporary, info);
    if (lockHandle) {
      try { await lockHandle.close(); } catch { /* Still attempt identity-checked lock cleanup. */ }
      if (lockInfo) {
        try {
          const lock = await readProtected(lockFile);
          if (sameFile(lock.info, lockInfo) && lock.bytes.toString('utf8') === token) await removeOwned(lockFile, lockInfo);
        } catch { /* A changed nonce is not this instance's lock anymore. */ }
      }
    }
  }

  async function persist(next) {
    try {
      validateLedger(next);
      const bytes = Buffer.from(JSON.stringify(next));
      if (bytes.length > MAX_BYTES) reject('UNAVAILABLE');
      await checkLock(); await checkLedger();
      const temporary = path.join(directory, `.state-${token}-${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      try {
        const info = await handle.stat(); privateStat(info); temporaryFiles.set(temporary, info);
        await handle.writeFile(bytes); await handle.sync();
      } finally { await handle.close(); }
      await checkLock(); await checkLedger();
      const named = await lstat(temporary); privateStat(named);
      if (!sameFile(named, temporaryFiles.get(temporary))) reject('UNAVAILABLE');
      await rename(temporary, file); temporaryFiles.delete(temporary);
      await syncDirectory(); await checkLock();
      const committed = await readProtected(file);
      if (digest(committed.bytes) !== digest(bytes)) reject('UNAVAILABLE');
      diskDigest = digest(bytes); ledger = next;
    } catch {
      poisoned = true;
      reject('UNAVAILABLE');
    }
  }

  function mutate(operation) {
    if (closing) return Promise.reject(Object.assign(new Error('Sandbox state operation rejected'), { code: 'SANDBOX_STATE_CLOSED' }));
    const pending = queue.then(async () => {
      if (poisoned) reject('UNAVAILABLE');
      return operation();
    });
    queue = pending.catch(() => {});
    return pending;
  }

  try {
    try { await mkdir(directory, { mode: 0o700 }); createdDirectory = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    directoryInfo = await lstat(directory); privateStat(directoryInfo, true); await checkDirectory();
    await syncCreatedDirectoryEntry();
    if (!createdDirectory) {
      // Only the mkdir winner may initialize. An early visitor must not steal
      // its writer lock while the new directory still has no committed ledger.
      const existing = await readProtected(file);
      validateLedger(JSON.parse(existing.bytes.toString('utf8')));
    }
    lockHandle = await open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    lockInfo = await lockHandle.stat(); privateStat(lockInfo);
    await lockHandle.writeFile(token); await lockHandle.sync(); await checkLock();
    let stored;
    try { stored = await readProtected(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stored) {
      ledger = JSON.parse(stored.bytes.toString('utf8')); validateLedger(ledger); diskDigest = digest(stored.bytes);
      if (!OWNER_KEYS.every(key => ledger.owner[key] === identity[key])) reject();
      const current = lastRun(ledger);
      if (current.runId === identity.runId) {
        if (current.runGeneration !== identity.runGeneration || current.sessionId !== identity.sessionId) reject();
      } else {
        if (current.state !== 'stopped' || identity.runGeneration <= current.runGeneration
          || ledger.runs.some(run => run.runId === identity.runId) || ledger.runs.length >= MAX_RUNS) reject();
        const next = structuredClone(ledger);
        next.runs.push({ runId: identity.runId, runGeneration: identity.runGeneration, sessionId: identity.sessionId, state: 'active' });
        await persist(next);
      }
    } else {
      // ENOENT in an installed directory is lost history, never permission to replay tasks.
      if (!createdDirectory) reject('UNAVAILABLE');
      await persist({ schemaVersion: 1, owner: Object.fromEntries(OWNER_KEYS.map(key => [key, identity[key]])),
        runs: [{ runId: identity.runId, runGeneration: identity.runGeneration, sessionId: identity.sessionId, state: 'active' }], tasks: [] });
    }
  } catch {
    await release(); reject('UNAVAILABLE');
  }

  return Object.freeze({
    reserve(input) {
      return mutate(async () => {
        exact(input, ['taskId', 'sessionId']);
        if (!isUuid(input.taskId) || input.sessionId !== identity.sessionId) reject();
        if (lastRun(ledger).state !== 'active' || ledger.tasks.length >= MAX_TASKS
          || ledger.tasks.some(task => task.taskId === input.taskId)) reject('CONFLICT');
        const next = structuredClone(ledger);
        const task = { taskId: input.taskId, runId: identity.runId, runGeneration: identity.runGeneration,
          sessionId: identity.sessionId, status: 'unknown', terminal: false };
        next.tasks.push(task); await persist(next); return freeze({ ...task });
      });
    },
    finish(taskId, status) {
      return mutate(async () => {
        if (!isUuid(taskId) || !STATUSES.includes(status)) reject();
        const index = ledger.tasks.findIndex(task => task.taskId === taskId);
        if (index < 0 || ledger.tasks[index].runId !== identity.runId || ledger.tasks[index].terminal) reject('CONFLICT');
        const next = structuredClone(ledger); next.tasks[index].status = status; next.tasks[index].terminal = true;
        await persist(next); return freeze({ ...next.tasks[index] });
      });
    },
    beginStop() {
      return mutate(async () => {
        if (lastRun(ledger).state !== 'active') {
          // Even idempotent calls must detect a lost directory, lock, or ledger.
          try { await checkLock(); await checkLedger(); } catch { poisoned = true; reject('UNAVAILABLE'); }
          return;
        }
        const next = structuredClone(ledger); lastRun(next).state = 'stopping'; await persist(next);
      });
    },
    confirmStopped(proof) {
      return mutate(async () => {
        exact(proof, ['runId', 'runGeneration', 'sandboxAbsent', 'controlAbsent']);
        if (proof.runId !== identity.runId || proof.runGeneration !== identity.runGeneration
          || proof.sandboxAbsent !== true || proof.controlAbsent !== true) reject();
        if (lastRun(ledger).state !== 'stopping') reject('CONFLICT');
        const next = structuredClone(ledger); lastRun(next).state = 'stopped'; await persist(next);
      });
    },
    snapshot() { return freeze(structuredClone(ledger)); },
    close() {
      if (!closePromise) { closing = true; closePromise = queue.then(release); }
      return closePromise;
    },
  });
}
