// pi 引擎端到端（local 形态，免 Docker / 免真实 provider key）：
// PiEngineAdapter（BAIRUI_PI_LOCAL=1）拉起真实 wrapper 子进程，wrapper 再以
// fake pi CLI 模拟 pi rpc JSONL 协议，验证「平台 adapter -> wrapper -> pi RPC」
// 全链路的 spawn / 健康 / 信封签名对话 / usage 汇总 / 停止。
//
// 真实 provider（如 DEEPSEEK_API_KEY）的 LLM 调用属部署期验收，不在 CI 覆盖范围。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiEngineAdapter } from '../src/runtime/engines/pi-engine.mjs';

const SECRET = 'pi-adapter-e2e-secret';

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
      write({ type: 'message_update', usage: { totalTokens: 7 }, assistantMessageEvent: { type: 'text_delta', delta: 'pi 引擎' } });
      write({ type: 'message_update', usage: { totalTokens: 7 }, assistantMessageEvent: { type: 'text_delta', delta: ' 端到端回复' } });
      write({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'pi 引擎 端到端回复' }], usage: { totalTokens: 7 } } });
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

test('pi 适配器端到端：local spawn -> wrapper -> rpc 对话 -> usage', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bairui-pi-e2e-'));
  const fakePiPath = join(dir, 'fake-pi.mjs');
  writeFileSync(fakePiPath, FAKE_PI_SOURCE, 'utf8');

  const adapter = new PiEngineAdapter({
    env: {
      BAIRUI_PI_LOCAL: '1',
      RUNTIME_SHARED_SECRET: SECRET,
      PI_SPAWN_CMD: 'node,' + fakePiPath,
      PI_PROVIDER: 'deepseek',
    },
  });

  try {
    assert.equal(adapter.canRun().ok, true);

    const spawned = await adapter.spawn({ agentId: 'agent-pi-e2e', provider: 'deepseek', model: 'deepseek-chat' });
    assert.equal(spawned.status, 'running');
    assert.equal(spawned.mode, 'local');
    assert.match(spawned.runtimeUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    assert.equal(adapter.route({ agentId: 'agent-pi-e2e' }).runtimeUrl, spawned.runtimeUrl);
    assert.equal((await adapter.health({ agentId: 'agent-pi-e2e' })).status, 'running');

    const events = [];
    const usage = await adapter.streamChat({
      agent: { id: 'agent-pi-e2e' },
      message: '你好',
      writeEvent: (event, data) => events.push({ event, data }),
    });
    assert.equal(usage.totalTokens, 7);
    assert.equal(usage.engine, 'pi');
    assert.deepEqual(events.map((item) => item.event), ['run.started', 'message.completed', 'run.completed']);
    assert.equal(events[1].data.content, 'pi 引擎 端到端回复');

    const stopped = await adapter.stop({ agentId: 'agent-pi-e2e' });
    assert.equal(stopped.stopped, true);
    assert.equal(adapter.route({ agentId: 'agent-pi-e2e' }).runtimeUrl, null);
  } finally {
    await adapter.stop({ agentId: 'agent-pi-e2e' }).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
