// bairui-agent-pi 实例侧 wrapper（docs/28 §3 / docs/31 §5）。
// 职责：把平台的单次对话任务翻译为 pi RPC 调用并回传结构化结果。
//   - 常驻一个 `pi --mode rpc --no-session` 子进程（stdin/stdout JSONL 协议，docs/31 §3 / upstreams rpc.md）；
//   - 镜像/进程启动时由平台注入 wrapper 输入 env（PI_PROVIDER/PI_MODEL/PI_OFFLINE 与真实
//     provider key env，如 DEEPSEEK_API_KEY）。pi 本身只读真实 provider env，不存在 PI_API_KEY。
//   - HTTP 端点：
//       GET  /healthz          -> 200 { status:'ok', engine:'pi' }
//       POST /v1/tasks         -> { content, totalTokens, engine:'pi', agentId }
//     请求体 { prompt, reset? }；reset=true（默认）每任务先 new_session，丢弃跨任务上下文。
//   - 若配置 RUNTIME_SHARED_SECRET，则校验平台信封头（与 apps/platform-api 的
//     boundary-envelope.mjs 同一 HMAC-SHA256 算法：sha256(secret, `${ts}.${nonce}.${rawBody}`)）。
//
// 单例子进程串行处理任务；子进程异常退出时自动重启（下个任务前探测）。

import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { StringDecoder } from 'node:string_decoder';

const PORT = Number(process.env.PORT ?? 8092);
const AGENT_ID = process.env.AGENT_ID ?? 'unknown';
const SHARED_SECRET = process.env.RUNTIME_SHARED_SECRET || '';
const PI_BIN = process.env.PI_BIN ?? 'pi';
// 测试/本地可用逗号分隔的可执行 argv 覆盖（如 PI_SPAWN_CMD=node,/path/fake-pi.mjs）。
const PI_SPAWN_CMD = (process.env.PI_SPAWN_CMD ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS ?? 180000);
// pi 的 new_session 是异步的，需等其 response 后才能发 prompt（见 runTask 注释）。
const SESSION_RESET_TIMEOUT_MS = Number(process.env.SESSION_RESET_TIMEOUT_MS ?? 60000);
const DEFAULT_RESET = process.env.CONTINUOUS_SESSION !== '1';
const NONCE_WINDOW_MS = 5 * 60 * 1000;
const seenNonces = new Set();

// ---------- 信封校验（算法与 platform boundary-envelope.mjs 保持一致） ----------

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

function verifyEnvelopeHeaders(headers, rawBody) {
  if (!SHARED_SECRET) return { ok: true };
  const timestamp = headers['x-bairui-timestamp'];
  const nonce = headers['x-bairui-nonce'];
  const signature = headers['x-bairui-signature'];
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > NONCE_WINDOW_MS) {
    return { ok: false, error: 'stale_timestamp' };
  }
  if (!nonce || seenNonces.has(nonce)) return { ok: false, error: 'replayed_nonce' };
  const expected = createHmac('sha256', SHARED_SECRET).update([String(ts), nonce, rawBody].join('.')).digest('hex');
  if (!safeEqualHex(expected, signature)) return { ok: false, error: 'invalid_signature' };
  seenNonces.add(nonce);
  return { ok: true };
}

// ---------- pi RPC 子进程管理（严格 JSONL over stdin/stdout） ----------

let pi = null;
let piAlive = false;
let sendQueue = Promise.resolve();
let seq = 0;
const eventListeners = new Set();

function sanitize(s) {
  return String(s).replace(/[\r\n\u2028\u2029]/g, ' ').trim();
}

function sendCommand(command) {
  const line = JSON.stringify(command);
  sendQueue = sendQueue.then(() => new Promise((resolve) => {
    pi.stdin.write(line + '\n', () => resolve());
  }));
  return sendQueue;
}

// 等待 pi 对指定命令的 response。
// 必要性：pi 的 new_session 是异步的（冷启动时可达数秒），若不等其 response 就发 prompt，
// prompt 会在会话重置窗口内被丢弃，模型永不执行，表现为前端一直等到 task_timeout。
function awaitResponse(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventListeners.delete(listener);
      reject(new Error(command + '_timeout'));
    }, timeoutMs);
    const listener = (event) => {
      if (event.type !== 'response' || event.command !== command) return;
      clearTimeout(timer);
      eventListeners.delete(listener);
      if (event.success) resolve(event);
      else reject(new Error(command + '_rejected: ' + (event.error ?? 'unknown')));
    };
    eventListeners.add(listener);
  });
}

function startPi() {
  return new Promise((resolve, reject) => {
    if (pi && piAlive) return resolve();
    const args = ['--mode', 'rpc', '--no-session'];
    const provider = process.env.PI_PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : process.env.OPENAI_API_KEY ? 'openai' : null);
    if (provider) args.push('--provider', provider);
    if (process.env.PI_MODEL) args.push('--model', process.env.PI_MODEL);

    const argv0 = PI_SPAWN_CMD.length > 0 ? PI_SPAWN_CMD[0] : PI_BIN;
    const argvRest = PI_SPAWN_CMD.length > 0 ? PI_SPAWN_CMD.slice(1) : [];
    let child = spawn(argv0, [...argvRest, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_OFFLINE: process.env.PI_OFFLINE ?? '1', PI_TELEMETRY: process.env.PI_TELEMETRY ?? '0' },
    });
    pi = child;
    piAlive = true;

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      while (true) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        for (const listener of [...eventListeners]) listener(event);
      }
    });
    child.stdout.on('end', () => {
      buffer += decoder.end();
    });

    const stderrChunks = [];
    child.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));
    child.on('exit', (code) => {
      piAlive = false;
      if (stderrChunks.length > 0) console.error('[pi-rpc] exited code=%s stderr=%s', code, stderrChunks.join('').slice(0, 800));
    });
    child.on('error', (error) => {
      piAlive = false;
      reject(error);
    });
    // 进程起来后即算就绪（pi RPC 模式会在首个命令后才真正初始化，但进程存在即可发送）。
    child.once('spawn', () => setTimeout(resolve, 250));
  });
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ': timed out after ' + ms + 'ms')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// 执行一次任务：可选 reset（new_session）后 prompt，等 agent_settled，返回最终 assistant 文本与 usage。
function runTask(promptText, reset) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timeoutMs = TASK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('task_timeout'));
    }, timeoutMs);

    let lastAssistantText = '';
    let totalTokens = null;
    let accepted = false;
    let rejectedError = null;

    const listener = (event) => {
      try {
        switch (event.type) {
          case 'response': {
            if (event.command === 'prompt') {
              if (event.success) accepted = true;
              else { rejectedError = event.error ?? 'prompt rejected'; cleanup(); reject(new Error(rejectedError)); }
            }
            break;
          }
          case 'message_update': {
            if (event.usage?.totalTokens != null) totalTokens = event.usage.totalTokens;
            const delta = event.assistantMessageEvent;
            if (delta?.type === 'text_delta' && typeof delta.delta === 'string') lastAssistantText += delta.delta;
            break;
          }
          case 'message_end': {
            const message = event.message;
            if (message?.role === 'assistant') {
              const text = collectText(message.content);
              if (text) lastAssistantText = text;
              if (message.usage?.totalTokens != null) totalTokens = message.usage.totalTokens;
            }
            break;
          }
          case 'agent_settled': {
            if (!accepted) break;
            cleanup();
            resolve({ content: lastAssistantText || null, totalTokens: totalTokens ?? (lastAssistantText ? lastAssistantText.length : 0) });
            break;
          }
          case 'extension_error': {
            console.warn('[wrapper] extension_error', event.extensionPath, event.error);
            break;
          }
          default:
            break;
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const cleanup = () => { clearTimeout(timer); eventListeners.delete(listener); };

    eventListeners.add(listener);
    (async () => {
      try {
        await startPi();
        if (reset) {
          // 必须先等 new_session 的 response，再发 prompt；两者连发会导致 prompt 被丢弃。
          const resetDone = awaitResponse('new_session', SESSION_RESET_TIMEOUT_MS);
          await sendCommand({ type: 'new_session' });
          await resetDone;
        }
        await sendCommand({ type: 'prompt', id: 'req-' + (++seq), message: promptText });
      } catch (error) {
        cleanup();
        reject(error);
      }
    })();
    if (started > 0) void started;
  });
}

function collectText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

// ---------- HTTP 服务 ----------

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

let taskChain = Promise.resolve();

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://pi-wrapper.local');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    return json(response, 200, { status: piAlive ? 'ok' : 'starting', engine: 'pi', agentId: AGENT_ID });
  }
  if (request.method === 'POST' && url.pathname === '/v1/tasks') {
    let raw;
    try {
      raw = await readBody(request);
    } catch {
      return json(response, 400, { error: 'read_failed' });
    }
    const verification = verifyEnvelopeHeaders(request.headers, raw);
    if (!verification.ok) return json(response, 401, { error: 'envelope_invalid', code: verification.error });
    let input;
    try {
      input = JSON.parse(raw || '{}');
    } catch {
      return json(response, 400, { error: 'invalid_json' });
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) return json(response, 422, { error: 'prompt_required' });
    if (!piAlive) {
      try { await startPi(); } catch (error) {
        return json(response, 503, { error: 'engine_unavailable', detail: String(error && error.message || error) });
      }
    }

    const reset = input.reset === undefined ? DEFAULT_RESET : Boolean(input.reset);
    // 串行执行，避免 RPC 流式期间第二个 prompt 被拒。
    taskChain = taskChain.then(async () => {
      try {
        const result = await withTimeout(runTask(sanitize(prompt), reset), TASK_TIMEOUT_MS + 15000, 'task');
        return json(response, 200, { ...result, engine: 'pi', agentId: AGENT_ID });
      } catch (error) {
        return json(response, 500, { error: 'task_failed', detail: String(error && error.message || error), agentId: AGENT_ID });
      }
    });
    return;
  }
  return json(response, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  const actual = server.address().port;
  console.log('pi wrapper listening on :' + actual + ' agent=' + AGENT_ID);
});
