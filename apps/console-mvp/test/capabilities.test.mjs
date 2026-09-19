import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
const api = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source.replaceAll('import.meta.env', '({})'))).toString('base64'));
const closed = { mode: 'platform', agentLifecycle: false, agentExecution: false, simulatedRecharge: false };
test('capabilities are closed by default and reject inconsistent or incomplete responses', async t => {
  assert.deepEqual(api.CLOSED_CAPABILITIES, closed);
  for (const capabilities of [closed, undefined, { mode: 'platform', agentLifecycle: true, agentExecution: true, simulatedRecharge: true }, { mode: 'legacy', agentLifecycle: 'true' }]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ provider: 'better-auth', capabilities }));
    if (capabilities === closed) assert.deepEqual(await api.fetchCapabilities(), closed);
    else await assert.rejects(api.fetchCapabilities(), /能力配置/);
  }
});
test('only explicit legacy capabilities enable controls; request errors do not enable fallback', async t => {
  const legacy = { mode: 'legacy', agentLifecycle: true, agentExecution: true, simulatedRecharge: true };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ capabilities: legacy }));
  assert.deepEqual(await api.fetchCapabilities(), legacy);
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 503 }));
  await assert.rejects(api.fetchCapabilities(), error => error.status === 503);
});
