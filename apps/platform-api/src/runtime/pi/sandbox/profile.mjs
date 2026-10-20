import path from 'node:path';
import { types } from 'node:util';
import { isModelId } from '../../../model-access/validation.mjs';

const ROOT_KEYS = ['schemaVersion', 'installationId', 'identity', 'sandboxImage', 'controlImage',
  'runtime', 'storageRoot', 'gatewayUrl', 'model', 'resources'];
const IDENTITY_KEYS = ['organizationId', 'ownerUserId', 'agentId', 'runId', 'runGeneration', 'sessionId'];
const MiB = 1024 ** 2;
const RESOURCE_BOUNDS = {
  cpuMillis: [100, 2000], memoryBytes: [128 * MiB, 4096 * MiB], pidsLimit: [16, 256],
  tmpfsBytes: [MiB, 64 * MiB], workspaceBytes: [16 * MiB, 10 * 1024 * MiB], workspaceInodes: [128, 100000],
};
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SESSION_ID = new RegExp(`^${UUID}$`);
const RUN_ID = new RegExp(`^(?:run-)?${UUID}$`);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

function invalid() {
  const error = new Error('Invalid sandbox profile');
  error.code = 'SANDBOX_PROFILE_INVALID';
  throw error;
}

// Inspect descriptors before reading values; getters must never supply configuration.
function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
  }
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) && value !== '.' && value !== '..';
}

function validStorageRoot(value) {
  return typeof value === 'string' && value.length <= 1024 && value !== '/'
    && /^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*)(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(value)
    && path.posix.normalize(value) === value;
}

function validGatewayUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\%\x00-\x1f\x7f]/.test(value)) return false;
  // Match the model proxy's fixed F2 endpoint grammar before URL normalization.
  if (!/^https:\/\/[^@/?#]+\/v1(?:\/|\/chat\/completions)?$/.test(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
    && !url.search && !url.hash && url.pathname.length <= 512;
}

/** Validate trusted machine configuration only. Does not inspect files or start workloads. */
export function validateSandboxProfile(value) {
  try {
    exactObject(value, ROOT_KEYS);
    exactObject(value.identity, IDENTITY_KEYS);
    exactObject(value.resources, Object.keys(RESOURCE_BOUNDS));
    for (const item of [...Object.values(value), ...Object.values(value.identity)]) {
      if (typeof item === 'string' && /[\x00-\x1f\x7f]/.test(item)) invalid();
    }
    if (value.schemaVersion !== 1 || typeof value.installationId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,47}$/.test(value.installationId)) invalid();
    const identity = value.identity;
    if (!['organizationId', 'ownerUserId', 'agentId'].every(key => safeId(identity[key]))
      || typeof identity.runId !== 'string' || !RUN_ID.test(identity.runId)
      || typeof identity.sessionId !== 'string' || !SESSION_ID.test(identity.sessionId)
      || !Number.isSafeInteger(identity.runGeneration) || identity.runGeneration <= 0) invalid();
    if (typeof value.sandboxImage !== 'string' || !IMAGE_ID.test(value.sandboxImage)
      || typeof value.controlImage !== 'string' || !IMAGE_ID.test(value.controlImage)
      || value.runtime !== 'runsc' || !validStorageRoot(value.storageRoot)
      || !validGatewayUrl(value.gatewayUrl) || !isModelId(value.model)) invalid();
    for (const [key, [minimum, maximum]] of Object.entries(RESOURCE_BOUNDS)) {
      const limit = value.resources[key];
      if (!Number.isSafeInteger(limit) || limit < minimum || limit > maximum) invalid();
    }
    return Object.freeze({
      schemaVersion: 1, installationId: value.installationId, identity: Object.freeze({ ...identity }),
      sandboxImage: value.sandboxImage, controlImage: value.controlImage, runtime: 'runsc',
      storageRoot: value.storageRoot, gatewayUrl: value.gatewayUrl, model: value.model,
      resources: Object.freeze({ ...value.resources }),
    });
  } catch {
    // URL errors and unusual objects must not expose private input in diagnostics.
    invalid();
  }
}
