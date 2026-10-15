import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { monitoringTarget } from '../src/monitoring-target.ts';

test('monitoring embeds only the fixed same-origin dashboard with an explicit known scope', () => {
  const local = '/api/admin/grafana/d/bairui-platform/bairui-platform?kiosk';
  assert.deepEqual(monitoringTarget({ dashboardUrl: local, scope: 'business' }), { url: local, scope: 'business' });
  assert.deepEqual(monitoringTarget({ dashboardUrl: local, scope: 'preprod' }), { url: local, scope: 'preprod' });
  for (const value of [{}, { dashboardUrl: local }, { dashboardUrl: local, scope: 'unknown' }, { dashboardUrl: null, scope: 'preprod' }]) assert.equal(monitoringTarget(value), null);
  for (const dashboardUrl of ['https://localhost:9443/d/bairui-platform/bairui-platform?kiosk', 'https://attacker.example', '//attacker.example', 'javascript:alert(1)', local + '&url=https://attacker.example', '/api/admin/grafana/login']) {
    assert.equal(monitoringTarget({ dashboardUrl }), null);
  }
});

test('monitoring uses an embedded dashboard, checks health for every scope and remounts on retry', async () => {
  const source = await readFile(new URL('../src/MonitoringView.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<a\b|target="_blank"|if \(!local\)|Windows/);
  assert.match(source, /\/api\/admin\/grafana\/api\/health/);
  assert.match(source, /<GrafanaFrame key=\{[^}]+\}/);
  assert.match(source, /set[A-Za-z]+\([^)]*=>[^)]*\+ 1/);
});
