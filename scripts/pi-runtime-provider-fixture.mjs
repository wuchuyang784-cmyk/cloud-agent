import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(v => v.type === 'text').map(v => v.text).join('\n') : '';
export function fixtureReply(messages) {
  const last = messages.findLastIndex(m => m.role === 'user'), prompt = text(messages[last]?.content);
  if (prompt.startsWith('F1_WRITE')) {
    const calls = messages.slice(last + 1).flatMap(m => m.tool_calls || []).map(c => c.function?.name);
    if (!calls.includes('write')) return { tool: { name: 'write', arguments: JSON.stringify({ path: 'f1-proof.txt', content: 'F1 proof\n' }) } };
    if (!calls.includes('read')) return { tool: { name: 'read', arguments: JSON.stringify({ path: 'f1-proof.txt' }) } };
    if (!calls.includes('bash')) return { tool: { name: 'bash', arguments: JSON.stringify({ command: "printf 'F1 shell proof\\n' > f1-shell-proof.txt" }) } };
    return { text: 'F1 tool proof complete' };
  }
  if (prompt.startsWith('F1_CONTEXT')) {
    const remembered = messages.slice(0, last).some(m => m.role === 'tool' && text(m.content).includes('F1 proof'));
    return { text: remembered ? 'F1 previous conversation remembered' : 'F1 previous conversation missing' };
  }
  if (prompt.startsWith('F1_CANCEL')) return { stall: true };
  if (prompt.startsWith('F1_ERROR')) return { error: true };
  if (prompt.startsWith('F1_OVERFLOW')) return { overflow: true };
  if (prompt.startsWith('F1_NO_USAGE')) return { text: 'F1 no usage provided', noUsage: true };
  return { text: 'F1 fixture response' };
}

export async function startFixture(directory = '/fixture') {
  const token = (await readFile(directory + '/model-token', 'utf8')).trim(), records = [];
  let stalledClosed = 0, activeStalls = 0;
  const provider = httpsServer({ key: await readFile(directory + '/key.pem'), cert: await readFile(directory + '/cert.pem') }, async (req, res) => {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }
    let size = 0, chunks = [];
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('request_limit'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString()), messages = body.messages;
      if (body.model !== 'pi-test-model' || body.stream !== true || !Array.isArray(messages)) throw new Error('invalid_fixture_request');
      const reply = fixtureReply(messages), prompt = text(messages.findLast(m => m.role === 'user')?.content);
      records.push({ messageCount: messages.length, promptKind: prompt.split('\n')[0], hasNewline: prompt.includes('\n'),
        tool: reply.tool?.name || null, toolResultPresent: messages.some(m => m.role === 'tool' && text(m.content).includes('F1 proof')),
        noUsage: reply.noUsage === true, error: reply.error === true,
        projectContextLoaded: messages.some(m => ['system', 'developer'].includes(m.role) && text(m.content).includes('F1_CONTEXT_POISON')) });
      if (records.length > 128) throw new Error('fixture_record_limit');
      if (reply.error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'FIXTURE_PRIVATE_ERROR /private/f1-secret.txt token-' + token, type: 'server_error' } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.flushHeaders();
      const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'fixture-' + records.length, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      if (reply.stall) {
        activeStalls++; chunk({ role: 'assistant', content: 'F1 waiting' });
        const timeout = setTimeout(() => res.destroy(), 30000);
        res.once('close', () => { clearTimeout(timeout); activeStalls--; stalledClosed++; }); return;
      }
      if (reply.tool) {
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + records.length, type: 'function', function: reply.tool }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ role: 'assistant', content: reply.overflow ? 'x'.repeat(280000) : reply.text }); chunk({}, 'stop');
      }
      if (!reply.noUsage) res.write('data: ' + JSON.stringify({ id: 'usage', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  const control = httpServer((req, res) => {
    if (req.url !== '/status' || req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ records, activeStalls, stalledClosed }));
  });
  // Test-only ingress, fixed destination. Pi stays on the internal network;
  // only this trusted fixture may publish loopback ports on a separate bridge.
  const ingress = httpServer((req, res) => {
    if (!(req.method === 'GET' && ['/livez', '/readyz'].includes(req.url)) && !(req.method === 'POST' && /^\/v1\/tasks(?:\/[0-9a-f-]{36}\/cancel)?$/.test(req.url))) { res.writeHead(404); res.end(); return; }
    const upstream = httpRequest({ hostname: 'pi-runtime', port: 8092, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); });
    req.pipe(upstream); res.once('close', () => upstream.destroy());
  });
  await Promise.all([new Promise(resolvePromise => provider.listen(8443, '0.0.0.0', resolvePromise)), new Promise(resolvePromise => control.listen(8088, '0.0.0.0', resolvePromise)), new Promise(resolvePromise => ingress.listen(8089, '0.0.0.0', resolvePromise))]);
  const close = () => { for (const server of [provider, control, ingress]) { server.closeAllConnections(); server.close(); } };
  process.on('SIGTERM', close); process.on('SIGINT', close);
  return { close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startFixture().catch(() => { process.stderr.write('f1_fixture_startup_failed\n'); process.exitCode = 1; });
}
