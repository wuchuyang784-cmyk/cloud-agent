import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlertReceiver, readAlertRecords } from '../src/monitoring/alert-receiver.mjs';
import { createGrafanaProxy } from '../src/admin/grafana-proxy.mjs';
import { PassThrough } from 'node:stream';

test('opt-in publisher monitoring binds fixed targets/environment, aggregates shared DB gauges and never embeds tokens', async () => {
  const { announcementMonitoringAssets } = await import('../../../scripts/announcement-monitoring-config.mjs');
  const asset = announcementMonitoringAssets({ environment: 'business', targets: ['127.0.0.1:9496'] });
  assert.equal(asset.scrape.job_name, 'bairui-announcement-publisher-business');
  assert.equal(asset.scrape.authorization.credentials_file, '/run/secrets/announcement-business-metrics');
  assert.equal(asset.rules.groups[0].rules.length, 5); assert.equal(asset.panels.length, 4);
  assert.ok(asset.rules.groups[0].rules.every(rule => rule.expr.includes('bairui_environment="business"')));
  assert.ok(asset.panels.some(panel => panel.targets[0].expr.startsWith('max(')));
  assert.doesNotMatch(JSON.stringify(asset), /password|api-key|userId|announcementId/);
  for (const options of [{ environment: 'other', targets: ['127.0.0.1:9496'] }, { environment: 'business', targets: [] },
    { environment: 'business', targets: ['https://evil/metrics'] }, { environment: 'business', targets: ['127.0.0.1:0'] }]) {
    assert.throws(() => announcementMonitoringAssets(options));
  }
});

test('existing alert receiver persists all fixed publisher firing and resolved names without identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bairui-publisher-alert-')), token = randomBytes(32).toString('hex');
  const receiver = createAlertReceiver({ token, directory });
  try {
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const names = ['AnnouncementPublisherUnavailable','AnnouncementPublisherCycleFailed','AnnouncementPublishDelayed','AnnouncementPublishBlocked','AnnouncementPublishFailed'];
    for (const status of ['firing', 'resolved']) {
      const response = await fetch('http://127.0.0.1:' + receiver.address().port + '/alerts', { method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ version: '4', status,
          alerts: names.map(alertname => ({ status, labels: { alertname, severity: 'warning', bairui_environment: 'business' } })) }) });
      assert.equal(response.status, 200);
    }
    const records = await readAlertRecords(directory); assert.equal(records.length, 10);
    assert.ok(records.every(row => row.instance === null));
  } finally {
    await new Promise(resolve => { receiver.close(resolve); receiver.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('opt-in publisher panels pass the same-origin fixed PromQL gate without allowing arbitrary expressions', async () => {
  const { announcementMonitoringAssets } = await import('../../../scripts/announcement-monitoring-config.mjs');
  const { publisherDashboardExpressions } = await import('../src/admin/grafana-dashboard.mjs');
  assert.equal(typeof publisherDashboardExpressions, 'function');
  for (const environment of ['business', 'preprod']) {
    const asset = announcementMonitoringAssets({ environment, targets: ['127.0.0.1:9496'] });
    assert.deepEqual(asset.panels.map(panel => panel.targets[0].expr), publisherDashboardExpressions(environment));
    const proxy = createGrafanaProxy({ baseUrl: 'http://127.0.0.1:9493', publicOrigin: 'https://localhost:8443', token: randomBytes(32).toString('hex'),
      fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) });
    for (const expr of [...publisherDashboardExpressions(environment), 'max(bairui_announcement_publisher_pending{userId="private"})']) {
      const request = Object.assign(new PassThrough(), { method: 'POST', url: '/api/admin/grafana/api/ds/query', headers: { origin: 'https://localhost:8443', 'content-type': 'application/json' } });
      request.end(); let rejected;
      const response = Object.assign(new PassThrough(), { writeHead() {} });
      await proxy.handle({ request, response, url: new URL('https://localhost:8443' + request.url), principal: {},
        readJson: async () => ({ from: String(Date.now()-60000), to: String(Date.now()), queries: [{ refId: 'A', expr, datasource: { uid: 'bairui-prometheus', type: 'prometheus' } }] }),
        fail: status => { rejected = status; } });
      assert.equal(rejected, expr.includes('private') ? 422 : undefined);
    }
  }
});
