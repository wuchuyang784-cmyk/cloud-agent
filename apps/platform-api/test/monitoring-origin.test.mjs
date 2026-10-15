import test from 'node:test';
import assert from 'node:assert/strict';

test('public monitoring origins require canonical origin syntax and HTTPS except local loopback', async () => {
  const module = await import('../src/admin/monitoring-origin.mjs').catch(() => ({}));
  assert.equal(typeof module.monitoringPublicOrigin, 'function', 'shared origin validator exists');
  const validate = module.monitoringPublicOrigin;
  assert.equal(validate(undefined), 'http://localhost:5173');
  for (const value of ['http://localhost:5173', 'https://localhost', 'http://127.0.0.1:5173', 'http://[::1]:5173', 'https://cloud.example.test']) assert.equal(validate(value), value);
  for (const value of ['', null, 1, 'http://cloud.example.test', 'https://user:pass@cloud.example.test', 'https://cloud.example.test/',
    'https://cloud.example.test/path', 'https://cloud.example.test?x=1', 'https://cloud.example.test#x', ' https://cloud.example.test',
    'https://cloud.example.test\n', 'https://cloud.example.test\t', 'https://CLOUD.example.test', 'https://cloud.example.test:443',
    'https://cloud.example.test:8443', 'http://127.1', 'http://2130706433', 'http://localhost.evil.test', 'https://cloud.example.test\\evil']) assert.throws(() => validate(value), /invalid_monitoring_public_origin/, String(value));
  assert.throws(() => validate(undefined, 'http://cloud.example.test'), /invalid_monitoring_public_origin/);
});
