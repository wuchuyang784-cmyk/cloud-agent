// pi wrapper（apps/platform-api/src/runtime/pi/wrapper.mjs）端到端集成测试：
// 以 fake pi CLI（模拟 pi rpc JSONL 协议，upstreams/pi rpc.md）驱动 wrapper 子进程，
// 验证信封校验、任务转发、usage 汇总与端口健康检查。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { envelopeHeaders } from '../src/runtime/boundary-envelope.mjs';

const SECRET = 'pi-wrapper-test-secret';
const WRAPPER_PATH = fileURLToPath(new URL('../src/runtime/pi/wrapper.mjs', import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const FAKE_PI_SOURCE = `import process from 'node:process';
const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
function handle(line) {
  if (!line) return;
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'new_session') {
    write({ type: 'response', command: 'new_session', success: true });
  } else if (event.type === 'prompt') {
    write({ type: 'response', command: 'prompt', success: true, id: event.id });
    setTimeout(() => {
      write({ type: 'message_update', usage: { totalTokens: 12 }, assistantMessageEvent: { type: 'text_delta', delta: '你好，这是' } });
      write({ type: 'message_update', usage: { totalTokens: 12 }, assistantMessageEvent: { type: 'text_delta', delta: ' fake pi 的回复' } });
      write({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好，这是 fake pi 的回复' }], usage: { totalTokens: 12 } } });
      write({ type: 'agent_settled' });
    }, 10);
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    handle(line);
  }
});
`;

async function waitHealthy(base, deadlineMs = 10000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + '/healthz');
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('wrapper 未在时限内健康');
}

test('pi wrapper：信封校验 + 任务转发 + usage 汇总', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bairui-pi-wrapper-'));
  const fakePiPath = join(dir, 'fake-pi.mjs');
  writeFileSync(fakePiPath, FAKE_PI_SOURCE, 'utf8');

  const port = await freePort();
  const wrapper = spawn('node', [WRAPPER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      RUNTIME_SHARED_SECRET: SECRET,
      AGENT_ID: 'agent-wrapper-test',
      PI_SPAWN_CMD: 'node,' + fakePiPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  wrapper.stdout.on('data', (chunk) => logs.push(String(chunk)));
  wrapper.stderr.on('data', (chunk) => logs.push(String(chunk)));

  const base = 'http://127.0.0.1:' + port;
  try {
    await waitHealthy(base);

    // 无签名请求（已配置 secret）→ 401
    const unsigned = await fetch(base + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    });
    assert.equal(unsigned.status, 401);

    // 信封签名请求 → 200，内容与 usage 正确
    const raw = JSON.stringify({ prompt: '你好', reset: true });
    const response = await fetch(base + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...envelopeHeaders({ secret: SECRET, body: raw }) },
      body: raw,
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.engine, 'pi');
    assert.equal(payload.agentId, 'agent-wrapper-test');
    assert.equal(payload.content, '你好，这是 fake pi 的回复');
    assert.equal(payload.totalTokens, 12);

    // 篡改 body → 401（时间戳窗口内同 nonce 也不匹配）
    const tampered = await fetch(base + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...envelopeHeaders({ secret: SECRET, body: raw }) },
      body: JSON.stringify({ prompt: '改过的内容', reset: true }),
    });
    assert.equal(tampered.status, 401);

    const missingPrompt = await fetch(base + '/v1/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...envelopeHeaders({ secret: SECRET, body: JSON.stringify({ prompt: '' }) }) },
      body: JSON.stringify({ prompt: '' }),
    });
    assert.equal(missingPrompt.status, 422);
  } finally {
    wrapper.kill('SIGTERM');
    await new Promise((resolve) => wrapper.once('exit', resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
