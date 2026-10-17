import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('unified console preserves five original items, adds announcements and keeps fixed read-only Grafana source', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  for (const label of ['平台概览', '用户账号', 'Agent 服务', '运行监控', '告警', '公告管理']) assert.ok(app.includes(label), label);
  const editor = await readFile(new URL('../src/AnnouncementEditor.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(editor, /dangerouslySetInnerHTML|localStorage|sessionStorage/);
  assert.match(editor, /确认发布/); assert.match(editor, /撤回原因/);
  assert.match(editor, /\{draft && <button type="button" onClick=\{\(\) => setPreview/);
  const monitor = await readFile(new URL('../src/MonitoringView.tsx', import.meta.url), 'utf8');
  const targets = await readFile(new URL('../src/monitoring-target.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(targets, /localhost:9443/);
  assert.match(targets, /\/api\/admin\/grafana\/d\/bairui-platform\/bairui-platform\?kiosk/);
  assert.match(monitor, /只读运行监控/);
  assert.doesNotMatch(monitor, /password|token|Authorization/i);
});

test('overview metrics stay readable without widening a 320px viewport', async () => {
  const overview = await readFile(new URL('../src/OverviewView.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.match(overview, /formatMetricValue\(key, metric\?\.value\)/);
  assert.match(styles, /body\s*\{[^}]*min-width:\s*0;/s);
  assert.match(styles, /\.metric-card strong\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
});
