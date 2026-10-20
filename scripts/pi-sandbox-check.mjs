import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSandboxProfile } from '../apps/platform-api/src/runtime/pi/sandbox/profile.mjs';
import { compileSandboxPolicy } from '../apps/platform-api/src/runtime/pi/sandbox/policy.mjs';

const MAX_CONFIG_BYTES = 16 * 1024;
const FAILURE = 'Sandbox policy check failed';

function invalid() {
  throw new Error(FAILURE);
}

function sameIdentity(first, second) {
  return ['dev', 'ino', 'mode', 'uid', 'gid'].every(key => first[key] === second[key]);
}

function sameFile(first, second) {
  return sameIdentity(first, second)
    && ['size', 'mtimeNs', 'ctimeNs', 'nlink'].every(key => first[key] === second[key]);
}

function privateRegularFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0n || stat.size > BigInt(MAX_CONFIG_BYTES)) invalid();
  // Windows ACLs are not POSIX modes; this does not claim to validate Windows ACL privacy.
  if (process.platform !== 'win32'
    && (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o177n) !== 0n
      || (stat.mode & 0o7000n) !== 0n)) invalid();
}

async function inspectPath(filename) {
  const root = path.parse(filename).root;
  const segments = path.relative(root, filename).split(path.sep).filter(Boolean);
  let current = root;
  const entries = [];
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = path.join(current, segments[index]);
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) invalid();
    if (index < segments.length - 1 && !stat.isDirectory()) invalid();
    entries.push(stat);
  }
  if (await realpath(filename) !== filename) invalid();
  privateRegularFile(entries.at(-1));
  return entries;
}

/** Read only an explicit bounded private regular JSON file. No configuration fallback. */
export async function readSandboxProfileFile(configFile) {
  let handle;
  try {
    if (typeof configFile !== 'string' || !configFile || configFile.includes('\0')) invalid();
    const filename = path.resolve(configFile);
    const beforePath = await inspectPath(filename);
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const beforeFile = await handle.stat({ bigint: true });
    privateRegularFile(beforeFile);
    if (!sameFile(beforePath.at(-1), beforeFile)) invalid();
    // A fixed size+1 buffer detects growth without ever following an unbounded writer.
    const bytes = Buffer.alloc(Number(beforeFile.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== Number(beforeFile.size)) invalid();
    const afterFile = await handle.stat({ bigint: true });
    const afterPath = await inspectPath(filename);
    if (!sameFile(beforeFile, afterFile) || !sameFile(afterFile, afterPath.at(-1))
      || beforePath.length !== afterPath.length
      || !beforePath.every((stat, index) => sameIdentity(stat, afterPath[index]))) invalid();
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    return validateSandboxProfile(JSON.parse(json));
  } catch {
    invalid();
  } finally {
    if (handle) {
      try { await handle.close(); } catch { invalid(); }
    }
  }
}

/** Compile policy data and return a deliberately allowlisted, non-deployable summary. */
export async function checkSandboxPolicyFile(configFile) {
  try {
    const profile = await readSandboxProfileFile(configFile);
    const policy = compileSandboxPolicy(profile);
    return Object.freeze({
      mode: 'policy-only', deploymentReady: false, nativeChecksPerformed: false,
      names: Object.freeze({ sandbox: policy.names.sandbox, control: policy.names.control }),
      requiredNativeChecks: Object.freeze([
        'runsc', 'images', 'quotas', 'ownership', 'egress', 'process-cleanup', 'capacity',
      ]),
    });
  } catch {
    invalid();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--')) invalid();
    const summary = await checkSandboxPolicyFile(args[1]);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 1;
  }
}
