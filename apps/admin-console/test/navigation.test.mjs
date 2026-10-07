import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('unified console exposes the approved five-item structure and fixed read-only Grafana source', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  for (const label of ['平台概览', '用户账号', 'Agent 服务', '运行监控', '告警']) assert.ok(app.includes(label), label);
  const monitor = await readFile(new URL('../src/MonitoringView.tsx', import.meta.url), 'utf8');
  assert.match(monitor, /https:\/\/localhost:9443\/d\/bairui-platform\/bairui-platform\?kiosk/);
  assert.match(monitor, /只读运行监控/);
  assert.doesNotMatch(monitor, /password|token|Authorization/i);
});
