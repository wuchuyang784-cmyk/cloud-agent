import test from 'node:test';
import assert from 'node:assert/strict';

const { hasPersistedResolution } = await import('./monitoring-evidence.mjs').catch(() => ({}));
const recoveredAt = '2026-10-10T16:05:00.000Z';
const firing = { alertname: 'RuntimeControllerUnavailable', status: 'firing', receivedAt: '2026-10-10T16:04:15.655Z' };
const resolved = { ...firing, status: 'resolved', receivedAt: '2026-10-10T16:06:00.274Z' };

test('persisted recovery evidence remains valid across midnight and record ordering', () => {
  assert.equal(typeof hasPersistedResolution, 'function');
  for (const rows of [[firing, resolved], [resolved, firing]]) {
    assert.equal(hasPersistedResolution(rows, firing.alertname, recoveredAt), true);
  }
});

test('a newer firing cannot be hidden by an older resolution', () => {
  assert.equal(hasPersistedResolution([resolved, { ...firing, receivedAt: '2026-10-11T12:00:00.000Z' }], firing.alertname, recoveredAt), false);
});

test('a resolution predating the actual recovery is insufficient', () => {
  assert.equal(hasPersistedResolution([resolved], firing.alertname, '2026-10-11T12:00:00.000Z'), false);
});

test('missing, invalid or unrelated records do not prove recovery', () => {
  for (const rows of [[], [{ ...resolved, alertname: 'MonitoringTargetDown' }], [{ ...resolved, receivedAt: 'invalid' }]]) {
    assert.equal(hasPersistedResolution(rows, firing.alertname, recoveredAt), false);
  }
});
