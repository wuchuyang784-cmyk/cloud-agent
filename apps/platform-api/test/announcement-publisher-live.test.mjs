import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createPublisherFixture } from './helpers/announcement-publisher-fixture.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 150; i++) { if (await check()) return; await wait(100); } throw new Error('publisher_live_timeout'); }

test('restricted real publisher process checks, restarts missed schedules and recovers database login outage', { skip: !process.env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL, timeout: 60000 }, async () => {
  const f = await createPublisherFixture(); const directory = await mkdtemp(join(tmpdir(), 'bairui-publisher-live-'));
  const token = randomBytes(32).toString('hex'), tokenFile = join(directory, 'metrics-token'); await writeFile(tokenFile, token);
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(BAIRUI_|BETTER_AUTH_|DATABASE_URL$|PG)/.test(key)) delete env[key];
  Object.assign(env, { BAIRUI_ANNOUNCEMENT_PUBLISHER_ENABLED: '1', BAIRUI_ANNOUNCEMENT_PUBLISHER_DATABASE_URL: f.connectionString,
    BAIRUI_ANNOUNCEMENT_PUBLISHER_INTERVAL_MS: '100', BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_PORT: String(port), BAIRUI_ANNOUNCEMENT_PUBLISHER_METRICS_TOKEN_FILE: tokenFile });
  const children = [], outputs = [];
  const launch = (args = []) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/announcements/publisher-entry.mjs', import.meta.url)), ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', buffer => { text = (text + buffer).slice(-8192); });
    child.on('error', () => {}); children.push(child); outputs.push(() => text); return child;
  };
  const stop = async child => { if (child.exitCode !== null || child.signalCode !== null) return; const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; };
  const metrics = async () => (await fetch('http://127.0.0.1:' + port + '/metrics', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1000) })).text();
  const status = async id => (await f.elevated.query('SELECT status FROM platform_announcements WHERE id=$1', [id])).rows[0].status;
  try {
    const a = await f.schedule(); const check = launch(['--check']); assert.equal((await once(check, 'exit'))[0], 0); assert.equal(await status(a.id), 'scheduled');
    const onceChild = launch(['--once']); assert.equal((await once(onceChild, 'exit'))[0], 0); assert.equal(await status(a.id), 'scheduled');
    await f.due(a.id); let child = launch();
    await until(async () => {
      if (child.exitCode !== null) throw new Error('publisher_child_exited_' + child.exitCode + ':' + outputs.at(-1)());
      return await status(a.id) === 'published';
    }); await until(async () => /cycle_ok 1/.test(await metrics().catch(() => '')));
    await stop(child);
    const b = await f.schedule(); await f.due(b.id);
    child = launch(); await until(async () => await status(b.id) === 'published');
    await until(async () => /cycle_ok 1/.test(await metrics().catch(() => '')));
    await f.elevated.query('ALTER ROLE ' + f.publisherRole + ' NOLOGIN');
    await f.elevated.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND pid<>pg_backend_pid()', [f.publisherRole]);
    const c = await f.schedule(); await f.due(c.id);
    await until(async () => /cycle_ok 0/.test(await metrics().catch(() => '')));
    assert.equal(await status(c.id), 'scheduled');
    assert.match(await metrics(), /last_success_timestamp_seconds [0-9.]+/);
    await f.elevated.query('ALTER ROLE ' + f.publisherRole + ' LOGIN');
    await until(async () => await status(c.id) === 'published');
    await until(async () => /cycle_ok 1/.test(await metrics().catch(() => '')));
    await stop(child);
    assert.equal((await f.elevated.query("SELECT count(*)::int n FROM platform_announcement_audit WHERE action='published' AND executor_type='system'")).rows[0].n, 3);
    for (const output of outputs) { assert.doesNotMatch(output(), /password|postgresql:\/\/|scheduled.*body/); assert.equal(output().includes(token), false); }
  } catch (error) {
    console.error('live stage diagnostic:', outputs.map(read => read()).join(' | ')); throw error;
  } finally {
    await Promise.all(children.map(stop));
    await f.elevated.query('ALTER ROLE ' + f.publisherRole + ' LOGIN').catch(() => {}); await f.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('bairui-publisher-live-'));
    await rm(directory, { recursive: true, force: true });
  }
});
