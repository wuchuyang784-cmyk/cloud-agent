import test from 'node:test';
import assert from 'node:assert/strict';
const fixture = await import('./pi-runtime-provider-fixture.mjs').catch(() => ({}));
test('isolated provider fixture requests real write/read/bash tools in order', () => {
  assert.equal(typeof fixture.fixtureReply, 'function');
  const messages = [{ role: 'user', content: 'F1_WRITE\nkeep this newline' }];
  for (const name of ['write', 'read', 'bash']) {
    const result = fixture.fixtureReply(messages);
    assert.equal(result.tool.name, name);
    messages.push({ role: 'assistant', tool_calls: [{ function: { name } }] }, { role: 'tool', content: 'F1 proof' });
  }
  assert.equal(fixture.fixtureReply(messages).text, 'F1 tool proof complete');
  messages.push({ role: 'user', content: 'F1_CONTEXT' });
  assert.equal(fixture.fixtureReply(messages).text, 'F1 previous conversation remembered');
});
