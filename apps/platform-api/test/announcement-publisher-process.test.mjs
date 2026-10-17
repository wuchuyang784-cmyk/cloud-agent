import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configModule = () => import('../src/announcements/publisher-config.mjs');
const env = () => ({ BAIRUI_ANNOUNCEMENT_PUBLISHER_ENABLED: '1', BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL: 'postgresql://publisher:password@127.0.0.1:5432/notice_test',
  BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_TOKEN_FILE: '/run/secrets/announcement-metrics' });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = overrides => ({ processed: 0, published: 0, expired: 0, blocked: 0, failed: 0, pending: 0, maxDelaySeconds: 0, blockedTotal: 0, ...overrides });

test('publisher requires explicit isolated credentials, bounded config and safe pg authority', async () => {
  const { readPublisherConfig } = await configModule();
  const config = readPublisherConfig(env());
  assert.equal(config.intervalMs, 5000); assert.equal(config.limit, 50); assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 9496); assert.equal(config.ssl, false);
  for (const patch of [{ BAIRUI_ANNOUNCEMENT_PUBLISHER_ENABLED: undefined }, { BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL: undefined },
    { DATABASE_URL: env().BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL }, { BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_TOKEN_FILE: '' },
    ...['?host=evil', '?options=-c%20role%3Dpostgres', '?sslmode=no-verify', '#fragment'].map(tail => ({ BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL: env().BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL + tail })),
    { BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL: 'postgres://postgres:password@localhost/db' },
    { BAIRUI_ANNOUNCEMENT_PUBLISHER_INTERVAL_MS: '0' }, { BAIRUI_ANNOUNCEMENT_PUBLISHER_BATCH_SIZE: '51' },
    { BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_HOST: 'public.example' }, { BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_PORT: '0' },
    { BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL: 'postgres://publisher:password@db.example/db' }]) {
    assert.throws(() => readPublisherConfig({ ...env(), ...patch }), error => !error.message.includes('password'));
  }
  const remote = readPublisherConfig({ ...env(), BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL: 'postgres://publisher:password@db.example/db', BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_TLS: '1' });
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true });
});

test('publisher loop is serial, retries after failure, preserves success snapshot and drains shutdown', async () => {
  const { startPublisherLoop } = await import('../src/announcements/publisher.mjs');
  const values = [], errors = []; let calls = 0, active = 0, maximum = 0, release;
  const loop = startPublisherLoop({ intervalMs: 5, maxBackoffMs: 20, telemetry: { update: value => values.push(value) }, onError: code => errors.push(code),
    cycle: async () => { calls++; active++; maximum = Math.max(maximum, active); try {
      if (calls === 1) throw new Error('private SQL/body');
      if (calls === 2) return snapshot({ pending: 4 });
      await new Promise(resolve => { release = resolve; }); return snapshot();
    } finally { active--; } } });
  try {
    for (let i = 0; i < 100 && !release; i++) await wait(2);
    assert.ok(release); assert.equal(maximum, 1); assert.deepEqual(errors, ['announcement_publisher_cycle_failed']);
    assert.equal(values[0].ok, false); assert.equal(values[1].snapshot.pending, 4);
    let stopped = false; const closing = loop.close().then(() => { stopped = true; });
    await wait(5); assert.equal(stopped, false); release(); await closing;
    const count = calls; await wait(20); assert.equal(calls, count);
  } finally { release?.(); await loop.close(); }
});

test('publisher can close before first tick without doing work', async () => {
  const { startPublisherLoop } = await import('../src/announcements/publisher.mjs');
  let count = 0; const loop = startPublisherLoop({ cycle: async () => { count++; }, telemetry: { update() {} } });
  await loop.close(); await wait(5); assert.equal(count, 0);
});

test('publisher metrics are protected aggregates and failure retains last known snapshot, not fake zero', async () => {
  const { createPublisherTelemetry } = await import('../src/announcements/publisher-telemetry.mjs');
  const token = randomBytes(32).toString('hex'); const telemetry = createPublisherTelemetry({ token });
  try {
    await telemetry.start(); const base = 'http://127.0.0.1:' + telemetry.server.address().port;
    assert.equal((await fetch(base + '/metrics')).status, 401);
    const headers = { authorization: 'Bearer ' + token };
    assert.equal((await fetch(base + '/other', { headers })).status, 404);
    const initial = await (await fetch(base + '/metrics', { headers })).text();
    assert.match(initial, /bairui_announcement_publisher_cycle_ok 0/); assert.doesNotMatch(initial, /bairui_announcement_publisher_pending /);
    telemetry.update({ ok: true, snapshot: snapshot({ pending: 7, maxDelaySeconds: 42, published: 1 }) });
    telemetry.update({ ok: false });
    const response = await fetch(base + '/metrics', { headers }); const body = await response.text();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(body, /bairui_announcement_publisher_pending 7/); assert.match(body, /bairui_announcement_publisher_cycle_ok 0/);
    assert.match(body, /bairui_announcement_publisher_failures_total 1/); assert.match(body, /bairui_announcement_publisher_published_total 1/);
    assert.doesNotMatch(body, /userId|announcementId|password|body|\{[^}]*actor/);
    assert.throws(() => telemetry.update({ ok: true, snapshot: snapshot({ pending: NaN }) }));
  } finally { await telemetry.close(); }
});

test('publisher token file is bounded, validated and cannot be a directory', async () => {
  const { readPublisherToken } = await import('../src/announcements/publisher-entry.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'bairui-publisher-token-'));
  try {
    const file = join(directory, 'metrics-token'); const token = randomBytes(32).toString('hex');
    await writeFile(file, token + '\n'); assert.equal(await readPublisherToken(file), token);
    await writeFile(file, 'a'.repeat(5000)); await assert.rejects(readPublisherToken(file), /announcement_publisher_token_invalid/);
    await assert.rejects(readPublisherToken(directory), /announcement_publisher_token_invalid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('publisher entry is explicit and not wired into platform API/dev/legacy worker startup', async () => {
  const root = new URL('../../../', import.meta.url);
  for (const name of ['src/index.mjs', 'src/app.mjs', 'src/worker-index.mjs', 'src/scheduler/worker-index.mjs']) {
    assert.doesNotMatch(await readFile(new URL('../' + name, import.meta.url), 'utf8'), /publisher-entry|startPublisher\(/);
  }
  const scripts = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).scripts;
  assert.match(scripts['announcements:publisher'], /publisher-entry\.mjs$/);
  assert.doesNotMatch(scripts['announcements:publisher'], /env-file|worker/);
});
