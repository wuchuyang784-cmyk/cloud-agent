import test from 'node:test';
import assert from 'node:assert/strict';
import { monitoringTarget } from '../src/monitoring-target.ts';

test('monitoring embeds only the fixed same-origin business dashboard or existing preprod dashboard', () => {
  const local = '/api/admin/grafana/d/bairui-platform/bairui-platform?kiosk';
  assert.deepEqual(monitoringTarget({ dashboardUrl: local, scope: 'business' }), { url: local, scope: 'business' });
  assert.equal(monitoringTarget({}).scope, 'preprod');
  for (const dashboardUrl of ['https://attacker.example', '//attacker.example', 'javascript:alert(1)', local + '&url=https://attacker.example', '/api/admin/grafana/login']) {
    assert.equal(monitoringTarget({ dashboardUrl }), null);
  }
});
