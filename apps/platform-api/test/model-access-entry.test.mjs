import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
let api = {};
try { api = await import('../src/model-access/gateway-entry.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
test('private gateway entry is inert on import and exports explicit startup', () => { assert.equal(typeof api.startModelGateway, 'function'); });
test('standalone gateway fails before listening without explicit private configuration', async () => {
  const env = { ...process.env }; for (const name of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|PG)/.test(name)) delete env[name];
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/model-access/gateway-entry.mjs', import.meta.url))], { env, windowsHide: true, timeout: 5000 }), error => error.code === 1 && /model_gateway_start_failed/.test(error.stderr) && !/postgresql:|password|stack|Error:/.test(error.stderr));
});
