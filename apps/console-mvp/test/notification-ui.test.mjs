import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

test('notification center has pure-text details, recent and full views, explicit unknown/error and readonly feedback', async () => {
  const source = await readFile(new URL('../src/NotificationCenter.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|localStorage|sessionStorage/);
  for (const label of ['查看全部', '全部已读', '未读数未知', '账号服务已暂停', '已结束', '通知来源', '阅读状态', 'showModal']) assert.ok(source.includes(label), label);
  const css = await readFile(new URL('../src/notifications.css', import.meta.url), 'utf8');
  assert.ok(/\.nc-dialog\s*\{[^}]*margin:\s*auto\b/s.test(css), 'native dialog stays centered despite Tailwind preflight');
  assert.ok(source.includes('aria-label="通知操作恢复"'), 'unknown read remains retryable after closing its modal');
  assert.ok(source.includes('disabled={value.busy} onClick={close}'), 'unknown outcome must not trap the user in a modal');
});

test('failed logout clears notifications immediately and requests verified identity recovery only in the same session', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleLogout()'), end = source.indexOf('\n  async function submitAgent', start);
  const code = stripTypeScriptTypes(source.slice(start, end));
  for (const changed of [false, true]) {
    const events = [], gate = {}; gate.promise = new Promise((_, reject) => { gate.reject = reject; });
    const sessionGeneration = { current: 1 }, logoutPending = { current: false };
    const run = new Function('notices', 'setNoticeOpen', 'logoutAccount', 'clearUserSession', 'setError', 'sessionGeneration', 'logoutPending', 'window', code + ';return handleLogout;')(
      { reset: () => events.push('reset') }, () => {}, () => gate.promise, () => { sessionGeneration.current++; },
      () => events.push('error'), sessionGeneration, logoutPending, { dispatchEvent: event => events.push(event.type) });
    const pending = run(); assert.equal(events[0], 'reset');
    if (changed) sessionGeneration.current++;
    gate.reject(new Error('sign out unavailable')); await pending;
    assert.equal(events.includes('bairui:account-refresh'), !changed);
    assert.equal(events.includes('error'), !changed);
    if (!changed) assert.equal(logoutPending.current, false);
  }
});

test('App binds notification lifecycle independently and does not fabricate zero or decrement unread locally', async () => {
  const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('watchNotifications'));
  assert.doesNotMatch(source, /setUnread|nextNotices|fetchNotifications\(\)\.catch/);
  assert.match(source, /async function handleLogout\(\)\s*\{\s*notices\.reset\(\)/);
  assert.ok(source.includes("panel === 'notifications'"));
  assert.ok(source.includes('!logoutPending.current'), 'in-flight logout cannot restore notification identity');
  assert.ok(source.includes('notices.activate(next)'), 'a verified identity refresh can restore notifications after a failed logout');
});
