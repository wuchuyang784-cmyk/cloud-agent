import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const mode = process.argv[2];
const args = process.argv.slice(3);
function runFixture() {
const arg = flag => args[args.indexOf(flag) + 1];
const sessionFile = arg('--session');
const sessionId = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8').split('\n')[0]).id : randomUUID();
let context = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).slice(1).map(x => JSON.parse(x).prompt) : [];
let buffer = '';
const send = x => process.stdout.write(JSON.stringify(x) + '\n');
const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10 };
const secretValues = () => { const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8')); const state = process.env.HOME; return [readFileSync(join(state, '..', 'secrets', 'hmac'), 'utf8'), models.providers[arg('--provider')].apiKey]; };
let flood;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk; let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const cmd = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (mode === 'record-commands') appendFileSync(join(process.cwd(), 'commands.jsonl'), JSON.stringify(cmd.type) + '\n');
    if (cmd.type === 'get_state') {
      writeFileSync(join(process.cwd(), 'ready-request.json'), JSON.stringify({ pid: process.pid }));
      const reply = () => send({ type: 'response', command: mode === 'wrong-command' ? 'other' : cmd.type, id: mode === 'wrong-id' ? 'wrong' : mode === 'missing-id' ? undefined : cmd.id, success: true, data: { model: { provider: arg('--provider'), id: mode === 'wrong-model' ? 'other' : arg('--model') }, sessionFile: mode === 'wrong-session' ? '/other' : sessionFile, sessionId, isStreaming: false } });
      if (mode === 'delayed') setTimeout(reply, 200); else reply();
    } else if (cmd.type === 'prompt') {
      send({ type: 'response', id: cmd.id, command: 'prompt', success: true });
      if (mode === 'crash') { process.exit(1); }
      if (mode === 'overflow') { process.stdout.write('x'.repeat(300000) + '\n'); continue; }
      if (mode === 'hang' || mode === 'ignore-abort') continue;
      if (mode === 'cross-message-secret') {
        const [secret] = secretValues();
        for (const delta of ['before ' + secret.slice(0, 20), secret.slice(20) + ' after']) {
          send({ type: 'message_start', message: { role: 'assistant' } });
          send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
          send({ type: 'message_end', message: { role: 'assistant', usage, stopReason: 'stop' } });
        }
        send({ type: 'agent_settled' }); continue;
      }
      if (mode === 'raw-flood') {
        for (let i = 0; i < 10; i++) send({ type: 'turn_start', ignored: 'x'.repeat(50000) });
        send({ type: 'agent_settled' }); continue;
      }
      if (mode === 'output-flood') {
        send({ type: 'message_start', message: { role: 'assistant' } });
        flood = setInterval(() => { for (let i = 0; i < 16; i++) send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(8000) } }); }, 2);
        continue;
      }
      if (mode === 'no-assistant') { send({ type: 'agent_settled' }); continue; }
      if (mode === 'slow') {
        send({ type: 'agent_start' });
        setTimeout(() => { send({ type: 'message_start', message: { role: 'assistant' } }); send({ type: 'message_end', message: { role: 'assistant', usage, stopReason: 'stop' } }); send({ type: 'agent_settled' }); }, 200);
        continue;
      }
      send({ type: 'agent_start' });
      send({ type: 'message_start', message: { role: 'assistant' } });
      if (mode === 'secret-deltas') {
        const [secret, token] = secretValues();
        for (const delta of ['before ' + secret.slice(0, 10), secret.slice(10, 55), secret.slice(55) + ' middle ' + token.slice(0, 8), token.slice(8) + ' after']) send({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', delta } });
      } else send({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', delta: mode === 'inspect' ? JSON.stringify({ env: process.env, args }) : cmd.message === 'context' ? context.join('|') + '|context' : cmd.message } });
      send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: '/hidden' } });
      const resultText = mode === 'tool-error' ? '/private/internal raw-tool-error ' + secretValues().join(' ') : 'result';
      send({ type: 'tool_execution_update', toolCallId: mode === 'tool-error' ? resultText : 'call-1', toolName: 'read', partialResult: { content: [{ type: 'text', text: resultText }], details: { secret: true } } });
      send({ type: 'tool_execution_end', toolCallId: mode === 'tool-error' ? resultText : 'call-1', toolName: 'read', result: { content: [{ type: 'text', text: resultText }] }, isError: mode === 'tool-error' });
      const message = { role: 'assistant', content: [{ type: 'text', text: cmd.message }], usage: mode === 'unknown-usage' ? undefined : mode === 'all-zero-usage' ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } : usage, stopReason: mode === 'model-error' ? 'error' : 'stop', errorMessage: 'secret-error' };
      send({ type: 'message_end', message });
      if (mode === 'duplicate-message-end') send({ type: 'message_end', message });
      if (mode === 'multiple-usage') { send({ type: 'message_start', message: { role: 'assistant' } }); send({ type: 'message_end', message: { ...message, content: [{ type: 'text', text: 'second' }] } }); }
      send({ type: 'agent_end', messages: [message], willRetry: false });
      context.push(cmd.message);
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + '\n' + context.map((prompt, i) => JSON.stringify({ type: 'message', id: String(i), parentId: i ? String(i - 1) : null, timestamp: new Date().toISOString(), message: { role: 'user', content: prompt }, prompt })).join('\n') + '\n');
      send({ type: 'agent_settled' });
      if (mode === 'late-response') setTimeout(() => send({ type: 'response', command: 'prompt', id: cmd.id, success: true }), 50);
    } else if (cmd.type === 'abort') {
      if (mode === 'ignore-abort') continue;
      clearInterval(flood);
      send({ type: 'agent_settled' }); send({ type: 'response', id: cmd.id, command: cmd.type, success: true });
    } else send({ type: 'response', id: cmd.id, command: cmd.type, success: true });
  }
});
}
if (mode && args.includes('--session')) runFixture();
