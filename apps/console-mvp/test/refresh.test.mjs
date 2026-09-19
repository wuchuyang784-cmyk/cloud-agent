import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const marker = 'const refresh = useCallback(';
const start = source.indexOf(marker);
const end = source.indexOf('\n  }, []);', start);
assert.ok(start >= 0 && end > start, 'App refresh callback must exist');
// Exercise the actual callback with controlled transports, without duplicating its logic.
const callback = source.slice(start + marker.length, end) + '\n}';
const code = stripTypeScriptTypes('const refresh = ' + callback + ';');
const closed = { mode: 'platform', agentLifecycle: false, agentExecution: false, simulatedRecharge: false };
const legacy = { mode: 'legacy', agentLifecycle: true, agentExecution: true, simulatedRecharge: true };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(capabilityRequests) {
  const state = { capabilities: closed };
  const dependencies = {
    sessionGeneration: { current: 0 }, refreshGeneration: { current: 0 }, CLOSED_CAPABILITIES: closed,
    fetchCapabilities: () => capabilityRequests.shift()(),
  };
  for (const name of ['Agents', 'Resources', 'Usage', 'Favorites', 'Settings', 'Account', 'Transactions', 'Filings']) {
    dependencies['fetch' + name] = async () => [];
  }
  dependencies.fetchNotifications = async () => ({ notifications: [], unreadCount: 0 });
  for (const name of ['Capabilities', 'Refreshing', 'Agents', 'Resources', 'Usage', 'SelectedId', 'Favorites', 'Notifications', 'Unread', 'Settings', 'Account', 'Transactions', 'Filings', 'Error']) {
    const key = name[0].toLowerCase() + name.slice(1);
    dependencies['set' + name] = value => { state[key] = typeof value === 'function' ? value(state[key]) : value; };
  }
  const refresh = new Function(...Object.keys(dependencies), code + '; return refresh;')(...Object.values(dependencies));
  return { state, dependencies, refresh };
}

test('older enabling response cannot overwrite the latest failed refresh', async () => {
  const older = deferred();
  const error = new Error('capabilities unavailable');
  const h = harness([() => older.promise, () => Promise.reject(error)]);
  const pending = h.refresh();
  await h.refresh();
  assert.deepEqual(h.state.capabilities, closed);
  assert.equal(h.state.error, error.message);
  older.resolve(legacy);
  await pending;
  assert.deepEqual(h.state.capabilities, closed);
  assert.equal(h.state.error, error.message);
  assert.equal(h.state.refreshing, false);
});

test('older failed refresh cannot overwrite the latest successful state', async () => {
  const older = deferred();
  const h = harness([() => older.promise, async () => closed]);
  const pending = h.refresh();
  await h.refresh();
  older.reject(new Error('stale request failed'));
  await pending;
  assert.equal(h.state.error, null);
  assert.deepEqual(h.state.capabilities, closed);
  assert.equal(h.state.refreshing, false);
});

test('a response from a cleared session cannot repopulate data or capabilities', async () => {
  const older = deferred();
  const h = harness([() => older.promise]);
  const pending = h.refresh();
  h.dependencies.sessionGeneration.current++;
  h.dependencies.refreshGeneration.current++;
  const before = structuredClone(h.state);
  older.resolve(legacy);
  await pending;
  assert.deepEqual(h.state, before);
});
