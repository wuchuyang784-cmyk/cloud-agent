const RESOURCE_KEYS = Object.freeze(['cpuMillis', 'memoryBytes', 'pidsLimit', 'idleTtlSeconds']);
const RESOURCE_LIMITS = Object.freeze({
  cpuMillis: Object.freeze([100, 8000]),
  memoryBytes: Object.freeze([134217728, 17179869184]),
  pidsLimit: Object.freeze([16, 1024]),
  idleTtlSeconds: Object.freeze([60, 86400]),
});
const INSPECTION_STATUSES = new Set(['starting', 'running', 'stopping', 'stopped', 'absent']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIdentifier(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 200
    && !CONTROL_CHARACTERS.test(value);
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function assertRuntimeIdentity(value) {
  if (!isRecord(value)
    || !validIdentifier(value.agentId)
    || !validIdentifier(value.runId)
    || !Number.isSafeInteger(value.runGeneration)
    || value.runGeneration <= 0) throw new Error('runtime_identity_invalid');
}

function assertMatchingIdentity(value, expected) {
  if (!isRecord(value)
    || value.agentId !== expected?.agentId
    || value.runId !== expected?.runId
    || value.runGeneration !== expected?.runGeneration) throw new Error('orchestrator_identity_mismatch');
}

function validRuntimeLocation(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 2048 && !CONTROL_CHARACTERS.test(value);
}

function validOrchestratorRef(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 500 && !CONTROL_CHARACTERS.test(value);
}

export function normalizeResourceSpec(value) {
  if (!isRecord(value)
    || Object.keys(value).length !== RESOURCE_KEYS.length
    || Object.keys(value).some((key) => !RESOURCE_KEYS.includes(key))) throw new Error('resource_spec_invalid');
  const normalized = {};
  for (const key of RESOURCE_KEYS) {
    const number = value[key];
    const [minimum, maximum] = RESOURCE_LIMITS[key];
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new Error('resource_spec_invalid');
    normalized[key] = number;
  }
  return normalized;
}

export function buildStartRequest(spec) {
  assertRuntimeIdentity(spec);
  if (!['pi', 'dsh'].includes(spec.engine)) throw new Error('runtime_engine_invalid');
  return {
    agentId: spec.agentId,
    runId: spec.runId,
    runGeneration: spec.runGeneration,
    engine: spec.engine,
    resourceSpec: normalizeResourceSpec(spec.resourceSpec),
  };
}

export function buildStopRequest(spec) {
  assertRuntimeIdentity(spec);
  if (!Number.isSafeInteger(spec.fenceGeneration) || spec.fenceGeneration <= spec.runGeneration) throw new Error('runtime_fence_invalid');
  const reason = typeof spec.reason === 'string' ? spec.reason.trim() : '';
  if (reason.length < 1 || reason.length > 500 || CONTROL_CHARACTERS.test(reason)) throw new Error('runtime_reason_invalid');
  return {
    agentId: spec.agentId,
    runId: spec.runId,
    runGeneration: spec.runGeneration,
    fenceGeneration: spec.fenceGeneration,
    reason,
  };
}

export function parseStartConfirmation(value, expected) {
  assertMatchingIdentity(value, expected);
  if (value.status !== 'running'
    || !validOrchestratorRef(value.orchestratorRef)
    || !validRuntimeLocation(value.runtimeUrl)
    || !validIsoTimestamp(value.observedAt)) throw new Error('orchestrator_bad_response');
  return { ...value };
}

export function parseStopConfirmation(value, expected) {
  assertMatchingIdentity(value, expected);
  if (!['stopped', 'absent'].includes(value.status)
    || !validIsoTimestamp(value.confirmedAt)) throw new Error('orchestrator_bad_response');
  return { ...value };
}

export function parseInspection(value, expected) {
  assertMatchingIdentity(value, expected);
  if (!INSPECTION_STATUSES.has(value.status)
    || !validIsoTimestamp(value.observedAt)
    || (value.status === 'running'
      && (!validOrchestratorRef(value.orchestratorRef) || !validRuntimeLocation(value.runtimeUrl)))) {
    throw new Error('orchestrator_bad_response');
  }
  return { ...value };
}
