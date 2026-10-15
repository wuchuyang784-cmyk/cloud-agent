import { createServer } from 'node:http';
import { open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { validateConfig, prepareRuntime, UUID } from './config.mjs';
import { createEnvelopeVerifier } from './envelope.mjs';
import { PiRpc } from './rpc.mjs';

const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : '';
const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const emptyUsage = () => Object.fromEntries(usageKeys.map(k => [k, 0]));
function json(response, status, value) { if (response.destroyed || response.writableEnded) return; response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }
function failure(code, status) { return Object.assign(new Error(code), { status }); }

export async function createPiRuntimeService(options) {
  const paths = options.paths || { workspace: '/workspace', state: '/agent-state', secrets: '/run/secrets' };
  const config = validateConfig(options.config, { paths, fixtureGatewayHosts: options.fixtureGatewayHosts });
  const prepared = await prepareRuntime(config, paths);
  const verify = createEnvelopeVerifier(config, prepared.secret);
  const rpc = new PiRpc(config, prepared, paths, options.executable);
  let ready = false, closing = false, active = null, readers = 0, startPromise, closePromise;
  const tasksDir = prepared.tasks;
  const limits = config.limits;
  const protectedValues = [prepared.secret, prepared.token].sort((a, b) => b.length - a.length);
  const startup = (async () => {
    try {
      const state = await rpc.request('get_state');
      if (!state || state.model?.provider !== config.provider || state.model?.id !== config.model || state.sessionFile !== prepared.sessionFile || !UUID.test(state.sessionId) || state.isStreaming !== false) throw new Error('invalid_state');
      await rpc.request('set_auto_retry', { enabled: false });
      await rpc.request('set_auto_compaction', { enabled: false });
      if (!closing && !rpc.dead) ready = true;
    } catch { rpc.fail('readiness_failed'); }
  })();

  async function reserve(task) {
    const file = join(tasksDir, task.taskId + '.json');
    let handle;
    try {
      handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(JSON.stringify({ taskId: task.taskId, sessionId: config.sessionId, agentId: config.agentId, runId: config.runId, runGeneration: config.runGeneration, status: 'unknown', terminal: false }));
      await handle.sync();
    } catch (e) { throw failure(e.code === 'EEXIST' ? 'duplicate_task' : 'persistence_failed', e.code === 'EEXIST' ? 409 : 503); }
    finally { if (handle) await handle.close(); }
    // Directory fsync is unavailable on Windows, where tests do not claim power-loss durability.
    if (process.platform !== 'win32') { const dir = await open(tasksDir, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    return file;
  }
  async function persist(task, status) {
    const tmp = join(tasksDir, '.' + task.taskId + '.' + randomUUID());
    const file = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await file.writeFile(JSON.stringify({ taskId: task.taskId, sessionId: config.sessionId, agentId: config.agentId, runId: config.runId, runGeneration: config.runGeneration, status, terminal: true })); await file.sync(); } finally { await file.close(); }
    try { await rename(tmp, task.file); } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
    if (process.platform !== 'win32') { const dir = await open(tasksDir, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  }
  function emit(task, type, fields = {}, terminal = false) {
    if (task.response.destroyed || task.response.writableEnded) return;
    const line = JSON.stringify({ type, taskId: task.taskId, seq: task.seq + 1, ...fields }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (!terminal && (bytes > limits.maxEventBytes || task.seq >= limits.maxEvents || task.bytes + bytes > limits.maxOutputBytes || task.response.writableLength + bytes > limits.maxClientBufferBytes)) { void cancel(task, 'output_limit'); return; }
    task.seq++; task.bytes += bytes;
    if (!task.response.write(line) && !task.drainTimer) {
      task.drainTimer = setTimeout(() => { task.drainTimer = null; void cancel(task, 'slow_client'); task.response.destroy(); }, limits.requestTimeoutMs);
      task.response.once('drain', () => { clearTimeout(task.drainTimer); task.drainTimer = null; });
    }
  }
  function text(task, chunk = '', flush = false) {
    let value = task.textBuffer + clean(chunk);
    for (const secret of protectedValues) value = value.split(secret).join('[redacted]');
    let retain = 0;
    if (!flush) {
      for (const secret of protectedValues) {
        for (let length = Math.min(secret.length - 1, value.length); length > retain; length--) {
          if (value.endsWith(secret.slice(0, length))) { retain = length; break; }
        }
      }
    }
    const output = retain ? value.slice(0, -retain) : value;
    task.textBuffer = retain ? value.slice(-retain) : '';
    if (output) emit(task, 'message.delta', { text: output });
  }
  async function finish(task, status, code) {
    if (task.finishing) return task.finishing;
    task.finishing = (async () => {
      clearTimeout(task.timer); clearTimeout(task.cancelTimer); clearTimeout(task.drainTimer);
      rpc.endTask();
      try { await persist(task, status); } catch { status = 'failed'; code = 'persistence_failed'; ready = false; rpc.fail('persistence_failed'); }
      if (status === 'completed') emit(task, 'task.completed', { usage: task.usage }, true);
      else if (status === 'cancelled') emit(task, 'task.cancelled', { code: code || 'cancelled' }, true);
      else emit(task, 'task.failed', { code: code || (status === 'unknown' ? 'runtime_lost' : 'task_failed') }, true);
      if (!task.response.destroyed) task.response.end();
      if (active === task) active = null;
      task.resolveDone();
    })();
    return task.finishing;
  }
  async function cancel(task, reason) {
    if (active !== task || task.finishing || task.cancelReason) return;
    task.cancelReason = reason;
    // No prompt has been sent while disk reservation or a trusted dispatch gate is pending.
    if (task.phase !== 'running') return;
    task.cancelTimer = setTimeout(() => { ready = false; rpc.fail('cancel_unsettled'); }, limits.cancelGraceMs);
    try { await rpc.request('abort', {}, limits.cancelGraceMs); } catch { if (!task.finishing) { ready = false; rpc.fail('cancel_unsettled'); } }
  }
  function settle(task) {
    text(task, '', true);
    const reason = task.cancelReason;
    const status = reason ? (['cancelled', 'disconnect', 'shutdown'].includes(reason) ? 'cancelled' : 'failed') : task.failed || !task.assistantMessages ? 'failed' : 'completed';
    return finish(task, status, reason || (status === 'failed' ? 'model_failed' : undefined));
  }
  rpc.on('dead', () => { ready = false; if (active?.phase === 'running') void finish(active, 'unknown', active.cancelReason === 'timeout' ? 'timeout' : 'runtime_lost'); });
  rpc.on('event', event => {
    const task = active;
    if (!task || task.finishing || task.phase !== 'running') return;
    task.rpcEvents++;
    if (task.rpcEvents > limits.maxEvents) { void cancel(task, 'output_limit'); return; }
    if (event.type === 'agent_settled') {
      if (!task.accepted) { task.settled = true; return; }
      void settle(task);
    } else if (event.type === 'message_start' && event.message?.role === 'assistant') { task.messageOpen = true; }
    else if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') text(task, event.assistantMessageEvent.delta);
    else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      if (['error', 'aborted'].includes(event.message.stopReason)) task.failed = true;
      if (task.messageOpen) {
        task.messageOpen = false;
        task.assistantMessages++;
        const allZero = usageKeys.every(key => event.message.usage?.[key] === 0);
        for (const key of usageKeys) {
          const value = event.message.usage?.[key];
          if (allZero || task.usage[key] === null || !Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(task.usage[key] + value)) task.usage[key] = null;
          else task.usage[key] += value;
        }
      }
    } else if (event.type.startsWith('tool_execution_')) {
      // Tool arguments, results, errors, and raw IDs may contain paths or credentials.
      const toolName = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'].includes(event.toolName) ? event.toolName : 'unknown';
      const projection = { toolCallId: 'tool_' + createHash('sha256').update(typeof event.toolCallId === 'string' ? event.toolCallId : '').digest('hex').slice(0, 32), toolName };
      if (event.type === 'tool_execution_start') emit(task, 'tool.started', projection);
      else if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
        if (event.type === 'tool_execution_end') projection.isError = event.isError === true;
        emit(task, event.type === 'tool_execution_update' ? 'tool.update' : 'tool.completed', projection);
      }
    } else if (['auto_retry_start', 'summarization_retry_scheduled', 'extension_error'].includes(event.type)) { task.failed = true; void cancel(task, 'runtime_policy'); }
  });

  async function body(request) {
    if (readers >= limits.maxReaders) throw failure('too_many_readers', 429);
    readers++;
    try {
      return await new Promise((resolve, reject) => {
        const chunks = []; let size = 0, ended = false;
        const timer = setTimeout(() => fail(failure('request_timeout', 408)), limits.requestTimeoutMs);
        const cleanup = () => { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('aborted', aborted); request.off('error', aborted); };
        const fail = error => { if (ended) return; ended = true; cleanup(); request.resume(); reject(error); };
        const data = chunk => { size += chunk.length; if (size > limits.maxBodyBytes) fail(failure('body_limit', 413)); else chunks.push(chunk); };
        const end = () => { if (ended) return; ended = true; cleanup(); const buffer = Buffer.concat(chunks); const text = buffer.toString('utf8'); if (!buffer.equals(Buffer.from(text))) reject(failure('invalid_body', 400)); else resolve(text); };
        const aborted = () => fail(failure('invalid_body', 400));
        request.on('data', data); request.on('end', end); request.on('aborted', aborted); request.on('error', aborted);
      });
    } finally { readers--; }
  }
  function validateTask(value, isCancel, pathTaskId) {
    const keys = ['agentId', 'runId', 'runGeneration', 'sessionId', 'taskId', ...(isCancel ? [] : ['prompt'])];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(k => !keys.includes(k)) || !UUID.test(value.taskId)) throw failure('invalid_task', 400);
    if (value.agentId !== config.agentId || value.runId !== config.runId || value.runGeneration !== config.runGeneration || value.sessionId !== config.sessionId || (isCancel && value.taskId !== pathTaskId)) throw failure('identity_mismatch', 403);
    if (!isCancel && (typeof value.prompt !== 'string' || !value.prompt.length)) throw failure('invalid_task', 400);
    if (!isCancel && Buffer.byteLength(value.prompt) > limits.maxPromptBytes) throw failure('prompt_limit', 413);
  }
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    try {
      if (request.method === 'GET' && request.url === '/livez') return json(response, 200, { status: 'live' });
      if (request.method === 'GET' && request.url === '/readyz') return json(response, ready && !closing ? 200 : 503, { status: ready && !closing ? 'ready' : 'not_ready' });
      const cancelMatch = /^\/v1\/tasks\/([0-9a-f-]{36})\/cancel$/.exec(request.url);
      if (request.method !== 'POST' || (request.url !== '/v1/tasks' && !cancelMatch)) return json(response, 404, { code: 'not_found' });
      const raw = await body(request);
      if (!verify(request, raw)) throw failure('invalid_signature', 401);
      let value; try { value = JSON.parse(raw); } catch { throw failure('invalid_body', 400); }
      validateTask(value, Boolean(cancelMatch), cancelMatch?.[1]);
      if (cancelMatch) {
        if (!active || active.taskId !== value.taskId) throw failure('task_not_active', 409);
        void cancel(active, 'cancelled');
        return json(response, 200, { status: 'cancelling', taskId: value.taskId });
      }
      if (!ready || closing) throw failure('not_ready', 503);
      if (active) throw failure('busy', 409);
      const task = { taskId: value.taskId, response, seq: 0, bytes: 0, rpcEvents: 0, assistantMessages: 0, usage: emptyUsage(), accepted: false, failed: false, phase: 'reserving', textBuffer: '' };
      task.done = new Promise(resolve => { task.resolveDone = resolve; });
      // Claim the single slot before asynchronous disk operations.
      active = task;
      response.once('close', () => { if (!response.writableEnded) void cancel(task, 'disconnect'); });
      task.timer = setTimeout(() => void cancel(task, 'timeout'), limits.taskTimeoutMs);
      try { task.file = await reserve(task); } catch (e) { clearTimeout(task.timer); if (active === task) active = null; task.resolveDone(); throw e; }
      if (options.dispatchGate) {
        try { await options.dispatchGate(task.taskId); } catch { void finish(task, 'failed', 'dispatch_failed'); return; }
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      emit(task, 'task.started', { sessionId: config.sessionId });
      if (rpc.dead) { void finish(task, 'unknown', 'runtime_lost'); return; }
      if (task.cancelReason || closing || response.destroyed) { task.cancelReason ||= closing ? 'shutdown' : 'disconnect'; void settle(task); return; }
      task.phase = 'running'; rpc.beginTask();
      rpc.request('prompt', { message: value.prompt }).then(data => {
        if (!data || !['started', 'queued', 'handled'].includes(data.disposition)) {
          void finish(task, 'unknown', 'prompt_protocol');
          ready = false; rpc.fail('prompt_protocol');
          return;
        }
        if (data.disposition === 'handled') { void finish(task, 'failed', 'prompt_handled'); return; }
        task.accepted = true;
        if (task.settled && !task.finishing) void settle(task);
      }).catch(() => { if (!task.finishing) { ready = false; rpc.fail('prompt_failed'); void finish(task, 'unknown', 'prompt_failed'); } });
    } catch (error) { json(response, error.status || 503, { code: error.status ? error.message : 'runtime_unavailable' }); }
  });
  server.maxHeadersCount = 32; server.headersTimeout = limits.requestTimeoutMs; server.requestTimeout = limits.requestTimeoutMs; server.keepAliveTimeout = 1000;
  return {
    start() {
      if (!startPromise) startPromise = new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.listenPort, config.listenHost, () => resolve(server.address())); });
      return startPromise;
    },
    close() {
      if (!closePromise) closePromise = (async () => {
        closing = true; ready = false;
        if (active) { const task = active; await cancel(task, 'shutdown'); await task.done; }
        await rpc.close(); await startup;
        if (server.listening) { await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); }
      })();
      return closePromise;
    },
  };
}
