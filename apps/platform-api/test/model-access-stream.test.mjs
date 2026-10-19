import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
let api = {};
try { api = await import('../src/model-access/stream.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const chunk = (delta, finish_reason = null, usage) => ({ id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: 'model-a', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
const event = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
const terminal = event(chunk({}, 'stop'));
const done = event('[DONE]');
async function run(raw, extra = {}) {
  const writes = [], receipts = [];
  const bytes = Buffer.from(raw), source = Readable.from([...bytes].map(byte => Buffer.from([byte])));
  await api.forwardModelStream(source, { secrets: ['fixture-only-provider-key', 'fixture-only-runtime-token'], write: async text => { writes.push(text); }, finish: async result => { receipts.push(result); assert.doesNotMatch(writes.join(''), /finish_reason":"stop|\[DONE\]/); }, ...extra });
  return { text: writes.join(''), receipts };
}

test('SSE assembles UTF8 and known literal secrets across transport splits, commits before terminal frames', async () => {
  assert.equal(typeof api.forwardModelStream, 'function');
  const result = await run(event(chunk({ content: '你好 fixture-only-provider-key fixture-only-runtime-token' })) + terminal + event({ ...chunk({}), choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } }) + done);
  assert.match(result.text, /你好/); assert.doesNotMatch(result.text, /fixture-only/); assert.match(result.text, /\[DONE\]/);
  assert.deepEqual(result.receipts, [{ state: 'completed', inputTokens: 12, outputTokens: 4 }]);
});

test('missing, invalid or duplicate usage stays unknown instead of fabricated zero', async () => {
  assert.equal(typeof api.forwardModelStream, 'function');
  for (const usages of [[], [{ prompt_tokens: -1, completion_tokens: 2 }], [{ prompt_tokens: 1, completion_tokens: 2 }, { prompt_tokens: 1, completion_tokens: 2 }]]) {
    const result = await run(event(chunk({ content: 'ok' })) + terminal + usages.map(usage => event({ ...chunk({}), choices: [], usage })).join('') + done);
    assert.deepEqual(result.receipts, [{ state: 'completed', inputTokens: null, outputTokens: null }]);
    assert.doesNotMatch(result.text, /"usage"/);
  }
  const zero = await run(terminal + event({ ...chunk({}), choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) + done);
  assert.equal(zero.receipts[0].inputTokens, 0);
});

test('persistence failure withholds finish_reason, usage and DONE', async () => {
  assert.equal(typeof api.forwardModelStream, 'function'); const writes = [];
  await assert.rejects(run(event(chunk({ content: 'partial' })) + terminal + done, { write: async text => { writes.push(text); }, finish: async () => { throw new Error('database fixture failure with secret'); } }));
  assert.match(writes.join(''), /partial/); assert.doesNotMatch(writes.join(''), /finish_reason":"stop|\[DONE\]|database fixture/);
});

test('intermediate usage is not treated as an authoritative final report', async () => {
  const result = await run(event(chunk({ content: 'partial' }, null, { prompt_tokens: 3, completion_tokens: 1 })) + terminal + done);
  assert.deepEqual(result.receipts, [{ state: 'completed', inputTokens: null, outputTokens: null }]);
  assert.doesNotMatch(result.text, /"usage"/);
});

test('malformed, upstream-error, truncated and premature terminal streams fail without committing success', async () => {
  assert.equal(typeof api.forwardModelStream, 'function');
  for (const raw of [event({ error: { message: 'secret from provider' } }), event('{bad-json'), event(chunk({ content: 'partial' })), done, terminal + event(chunk({ content: 'after finish' })) + done]) {
    let committed = false;
    await assert.rejects(run(raw, { finish: async () => { committed = true; } }), { code: 'model_upstream_unavailable' });
    assert.equal(committed, false);
  }
});

test('SSE event and total byte bounds reject before forwarding an oversized event', async () => {
  assert.equal(typeof api.forwardModelStream, 'function');
  for (const limits of [{ maxEventBytes: 100 }, { maxOutputBytes: 100 }]) {
    const writes = [];
    await assert.rejects(run(event(chunk({ content: 'x'.repeat(256) })) + terminal + done, { limits, write: async text => { writes.push(text); } }), { code: 'model_gateway_limit' });
    assert.equal(writes.length, 0);
  }
});

test('tool call deltas retain the protocol fields needed by pi without forwarding extra upstream fields', async () => {
  assert.equal(typeof api.forwardModelStream, 'function');
  const tool = { index: 0, id: 'call-fixture', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } };
  const result = await run(event({ ...chunk({ tool_calls: [tool] }), internal_metadata: 'must-not-forward' }) + event(chunk({}, 'tool_calls')) + done);
  assert.match(result.text, /call-fixture/); assert.match(result.text, /bash/); assert.doesNotMatch(result.text, /internal_metadata|must-not-forward/);
});
