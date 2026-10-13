import { open, mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID = /^(?:run-)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULTS = Object.freeze({ rpcTimeoutMs: 10000, taskTimeoutMs: 300000, cancelGraceMs: 5000, requestTimeoutMs: 5000, maxBodyBytes: 65536, maxPromptBytes: 32768, maxReaders: 8, maxNonces: 4096, nonceTtlMs: 60000, maxLineBytes: 262144, maxRawRpcBytes: 4194304, maxEventBytes: 65536, maxEvents: 10000, maxOutputBytes: 2097152, maxClientBufferBytes: 131072, maxRpcPending: 8, maxSessionBytes: 67108864 });
const MAXIMUM = { ...DEFAULTS, rpcTimeoutMs: 30000, taskTimeoutMs: 600000, cancelGraceMs: 10000, requestTimeoutMs: 10000 };
function invalid() { throw new Error('invalid_config'); }
export function validateConfig(value, { paths = { workspace: '/workspace', state: '/agent-state', secrets: '/run/secrets' }, fixtureGatewayHosts = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const required = ['agentId', 'runId', 'runGeneration', 'sessionId', 'provider', 'model', 'gatewayUrl', 'gatewayTokenFile', 'hmacSecretFile', 'listenHost', 'listenPort'];
  const allowed = [...required, 'limits', 'gatewayCaFile'];
  if (Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !(k in value))) invalid();
  if (typeof value.agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.agentId) || !RUN_ID.test(value.runId) || !UUID.test(value.sessionId) || !Number.isSafeInteger(value.runGeneration) || value.runGeneration < 1) invalid();
  if (value.provider !== 'bairui-gateway' || typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.model)) invalid();
  let url; try { url = new URL(value.gatewayUrl); } catch { invalid(); }
  if (typeof value.gatewayUrl !== 'string' || url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && fixtureGatewayHosts.includes(url.hostname)))) invalid();
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(value.listenHost) || !Number.isInteger(value.listenPort) || value.listenPort < 0 || value.listenPort > 65535) invalid();
  for (const key of ['gatewayTokenFile', 'hmacSecretFile']) {
    const file = value[key];
    if (typeof file !== 'string' || !isAbsolute(file) || file !== resolve(file) || dirname(file) !== resolve(paths.secrets)) invalid();
  }
  if (value.gatewayTokenFile === value.hmacSecretFile) invalid();
  if (value.gatewayCaFile !== undefined && value.gatewayCaFile !== '/run/config/gateway-ca.pem') invalid();
  if (value.limits !== undefined && (!value.limits || typeof value.limits !== 'object' || Array.isArray(value.limits))) invalid();
  const limits = { ...DEFAULTS, ...value.limits };
  for (const [key, v] of Object.entries(limits)) if (!(key in DEFAULTS) || !Number.isSafeInteger(v) || v < 1 || v > MAXIMUM[key]) invalid();
  return Object.freeze({ ...value, limits: Object.freeze(limits) });
}

export async function readProtectedFile(path, maxBytes) {
  const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('invalid_file');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > maxBytes || stat.ino !== info.ino) throw new Error('invalid_file'); return await file.readFile('utf8'); } finally { await file.close(); }
}
export async function prepareRuntime(config, paths) {
  for (const root of Object.values(paths)) {
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink() || resolve(await realpath(root)) !== resolve(root)) throw new Error('invalid_path');
  }
  const secret = (await readProtectedFile(config.hmacSecretFile, 65)).trim();
  const token = (await readProtectedFile(config.gatewayTokenFile, 4096)).trim();
  if (!/^[0-9a-f]{64}$/.test(secret) || new Set(secret).size < 8 || !/^[A-Za-z0-9._~-]{8,4096}$/.test(token) || secret === token) throw new Error('invalid_secret');
  const sessions = join(paths.state, 'sessions'), tasks = join(paths.state, 'tasks'), agentDir = join(paths.state, 'trusted-config');
  for (const dir of [sessions, tasks, agentDir]) { await mkdir(dir, { recursive: true, mode: 0o700 }); if (!(await lstat(dir)).isDirectory() || (await lstat(dir)).isSymbolicLink() || resolve(await realpath(dir)) !== resolve(dir)) throw new Error('invalid_path'); }
  const sessionFile = join(sessions, config.sessionId + '.jsonl');
  try {
    const content = await readProtectedFile(sessionFile, config.limits.maxSessionBytes);
    const lines = content.split('\n').filter(Boolean); if (!lines.length) throw new Error('invalid_session');
    const records = lines.map(line => JSON.parse(line));
    const header = records[0];
    const entryTypes = ['message', 'thinking_level_change', 'model_change', 'usage', 'compaction', 'branch_summary', 'custom', 'custom_message', 'context_edit', 'label', 'session_info'];
    const ids = new Set();
    if (header.type !== 'session' || header.version !== 3 || !UUID.test(header.id) || !Number.isFinite(Date.parse(header.timestamp)) || header.cwd !== paths.workspace) throw new Error('invalid_session');
    for (const entry of records.slice(1)) {
      if (!entry || !entryTypes.includes(entry.type) || typeof entry.id !== 'string' || !entry.id.length || entry.id.length > 128 || ids.has(entry.id) || !Number.isFinite(Date.parse(entry.timestamp)) || (entry.parentId !== null && !ids.has(entry.parentId))) throw new Error('invalid_session');
      if (entry.type === 'message' && (!entry.message || typeof entry.message.role !== 'string')) throw new Error('invalid_session');
      ids.add(entry.id);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid_session'); }
  const settings = { defaultProvider: config.provider, defaultModel: config.model, defaultThinkingLevel: 'off', defaultProjectTrust: 'never', enableInstallTelemetry: false, enableAnalytics: false, enableSkillCommands: false, extensions: [], skills: [], prompts: [], packages: [], compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: config.limits.taskTimeoutMs } } };
  const models = { providers: { [config.provider]: { baseUrl: config.gatewayUrl, api: 'openai-completions', apiKey: token, authHeader: true, models: [{ id: config.model, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }] } } };
  for (const [name, data] of [['settings.json', settings], ['models.json', models], ['auth.json', {}]]) {
    const file = join(agentDir, name);
    try { if ((await lstat(file)).isSymbolicLink()) throw new Error('invalid_path'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await writeFile(file, JSON.stringify(data), { mode: 0o600 });
  }
  if (config.gatewayCaFile) await readProtectedFile(config.gatewayCaFile, 65536);
  return { secret, token, sessionFile, tasks, agentDir };
}
export async function readConfig(path) {
  try { return JSON.parse(await readProtectedFile(path, 16384)); } catch { throw new Error('invalid_config'); }
}
