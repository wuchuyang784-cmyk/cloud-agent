import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../src/app.mjs';
import { PostgresStore } from '../src/postgres-store.mjs';

test('infrastructure PostgreSQL: independent writer identity, two APIs, RLS, replay, bounds and revocation without 033', {
  skip: !process.env.BAIRUI_TEST_DATABASE_URL,
}, async () => {
  const connectionString = process.env.BAIRUI_TEST_DATABASE_URL;
  const suffix = randomBytes(8).toString('hex'), schema = 'infra_' + suffix, role = 'infra_app_' + suffix, login = 'infra_writer_' + suffix;
  const secondLogin = 'infra_second_' + suffix, unknownLogin = 'infra_unknown_' + suffix;
  const owner = new Pool({ connectionString });
  let elevated, pool, writer, secondWriter, unknownWriter;
  const apps = [];
  try {
    await owner.query('CREATE SCHEMA ' + schema);
    await owner.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    const password = randomBytes(24).toString('hex');
    await owner.query(`CREATE ROLE ${login} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    for (const identity of [secondLogin, unknownLogin]) await owner.query(`CREATE ROLE ${identity} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    elevated = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    const migrations = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(n => n.endsWith('.sql') && !n.startsWith('033')).sort()) {
      await elevated.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    await elevated.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + [role, login, secondLogin, unknownLogin].join(','));
    await elevated.query('GRANT EXECUTE ON FUNCTION platform_admin_read(text,text,text,text,integer,text,text), platform_infrastructure_read(text) TO ' + role);
    await elevated.query('GRANT EXECUTE ON FUNCTION platform_account_access(text) TO ' + role);
    await elevated.query('GRANT EXECUTE ON FUNCTION platform_infrastructure_report(jsonb) TO ' + [login, secondLogin, unknownLogin].join(','));
    await elevated.query("INSERT INTO users(id,email) VALUES('admin','admin@example.test'),('ordinary','ordinary@example.test')");
    await elevated.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES('admin','platform_viewer','test','test')");
    await elevated.query("INSERT INTO platform_infrastructure_sources(source_id,label,login_role) VALUES('local','本机资源',$1)", [login]);
    const writerUrl = new URL(connectionString); writerUrl.username = login; writerUrl.password = password;
    writer = new Pool({ connectionString: writerUrl.href, options: '-c search_path=' + schema + ',public' });
    writerUrl.username = secondLogin;
    secondWriter = new Pool({ connectionString: writerUrl.href, options: '-c search_path=' + schema + ',public' });
    writerUrl.username = unknownLogin;
    unknownWriter = new Pool({ connectionString: writerUrl.href, options: '-c search_path=' + schema + ',public' });
    pool = new Pool({ connectionString, options: '-c search_path=' + schema + ',public -c role=' + role });
    const store = new PostgresStore({ pool });
    for (let i = 0; i < 2; i++) {
      const app = createApp({ store, env: { NODE_ENV: 'test', BAIRUI_AUTH_MODE: 'better-auth' }, auth: {
        provider: 'better-auth', async resolve(req) { return { userId: req.headers['x-test-user'] || 'ordinary', organizationId: 'personal', role: 'org_admin' }; },
      } });
      await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); apps.push(app);
    }
    const get = (index = 0, actor = 'admin') => fetch('http://127.0.0.1:' + apps[index].address().port + '/api/admin/infrastructure', { headers: { 'x-test-user': actor } });
    assert.equal((await get(0, 'ordinary')).status, 403);
    assert.equal((await (await get()).json()).items[0].status, 'waiting');
    for (const table of ['platform_infrastructure_sources', 'platform_infrastructure_snapshots', 'users', 'platform_role_bindings']) {
      await assert.rejects(writer.query('SELECT * FROM ' + table), { code: '42501' });
    }
    await assert.rejects(writer.query("SELECT platform_infrastructure_read('admin')"), { code: '42501' });
    await assert.rejects(pool.query("SELECT platform_infrastructure_report('{}')"), { code: '42501' });
    await elevated.query('GRANT SELECT,INSERT,UPDATE,DELETE ON platform_infrastructure_sources,platform_infrastructure_snapshots TO ' + role);
    assert.equal((await pool.query('SELECT * FROM platform_infrastructure_snapshots')).rows.length, 0);
    await assert.rejects(pool.query("INSERT INTO platform_infrastructure_sources(source_id,label,login_role) VALUES('forged','forged','forged')"), { code: '42501' });
    const sample = { version: 1, sampledAt: new Date().toISOString(), host: { platform: 'win32', cpuCount: 4, cpuPercent: 10, memoryTotalBytes: 16000, memoryUsedBytes: 4000 },
      swarm: { status: 'unavailable', nodes: [], services: [] }, sourceId: 'forged-source', secret: 'never-return' };
    const report = data => writer.query('SELECT platform_infrastructure_report($1::jsonb) AS accepted', [JSON.stringify(data)]);
    assert.equal((await report(sample)).rows[0].accepted, true);
    assert.equal((await report(sample)).rows[0].accepted, false, 'equal/replayed timestamps cannot overwrite');
    assert.equal((await report({ ...sample, sampledAt: new Date(Date.now() - 2000).toISOString() })).rows[0].accepted, false);
    const stored = (await elevated.query('SELECT sampled_at,received_at,payload FROM platform_infrastructure_snapshots')).rows;
    for (const input of [null, {}, ...['now', 'today', 'tomorrow', 'infinity', sample.sampledAt.slice(0, -1)].map(sampledAt => ({ ...sample, sampledAt })), { ...sample, sampledAt: new Date(Date.now() + 20000).toISOString() },
      { ...sample, sampledAt: new Date(Date.now() - 120000).toISOString() }, { ...sample, secret: 'x'.repeat(262144) }]) await assert.rejects(report(input));
    assert.deepEqual((await elevated.query('SELECT sampled_at,received_at,payload FROM platform_infrastructure_snapshots')).rows, stored, 'rejected reports must preserve the last usable snapshot');
    assert.equal((await pool.query('SELECT * FROM platform_infrastructure_snapshots')).rows.length, 0, 'populated snapshots remain protected by FORCE RLS');
    assert.equal((await pool.query("UPDATE platform_infrastructure_snapshots SET payload='{}'")).rowCount, 0);
    assert.equal((await pool.query('DELETE FROM platform_infrastructure_snapshots')).rowCount, 0);
    await assert.rejects(unknownWriter.query('SELECT platform_infrastructure_report($1)', [JSON.stringify(sample)]), { code: '42501' });
    await elevated.query("INSERT INTO platform_infrastructure_sources(source_id,label,login_role) VALUES('other','其他采集源',$1)", [secondLogin]);
    await secondWriter.query('SELECT platform_infrastructure_report($1)', [JSON.stringify({ ...sample, sourceId: 'local', host: { ...sample.host, cpuPercent: 33 } })]);
    assert.equal((await elevated.query("SELECT payload->'host'->>'cpuPercent' AS cpu FROM platform_infrastructure_snapshots WHERE source_id='other'")).rows[0].cpu, '33');
    await owner.query('GRANT ' + secondLogin + ' TO ' + login);
    const switched = await writer.connect();
    try {
      await switched.query('SET ROLE ' + secondLogin);
      await switched.query('SELECT platform_infrastructure_report($1)', [JSON.stringify({ ...sample, sourceId: 'other', sampledAt: new Date(Math.max(Date.now(), Date.parse(sample.sampledAt) + 1)).toISOString() })]);
      assert.equal((await elevated.query("SELECT payload->'host'->>'cpuPercent' AS cpu FROM platform_infrastructure_snapshots WHERE source_id='other'")).rows[0].cpu, '33', 'SET ROLE and supplied sourceId cannot replace session_user binding');
    } finally { await switched.query('RESET ROLE'); switched.release(); }
    for (let i = 0; i < 2; i++) {
      const response = await get(i); assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.items[0].sourceId, 'local'); assert.equal(body.items[0].status, 'fresh');
      assert.equal(body.items[0].snapshot.host.cpuPercent, 10);
      assert.equal(JSON.stringify(body).includes('never-return'), false);
      assert.equal(JSON.stringify(body).includes(login), false);
    }
    await elevated.query("UPDATE platform_infrastructure_snapshots SET received_at=now()-interval '2 minutes'");
    assert.equal((await (await get()).json()).items[0].status, 'stale');
    await elevated.query("UPDATE platform_infrastructure_snapshots SET payload=jsonb_set(payload,'{host,cpuPercent}','101')");
    assert.equal((await (await get()).json()).items[0].status, 'invalid');
    await elevated.query("UPDATE platform_infrastructure_sources SET enabled=false");
    await assert.rejects(report({ ...sample, sampledAt: new Date().toISOString() }), { code: '42501' });
    assert.deepEqual((await (await get()).json()).items, []);
    await elevated.query("UPDATE platform_role_bindings SET revoked_at=now() WHERE user_id='admin'");
    for (let i = 0; i < 2; i++) assert.equal((await get(i)).status, 403);
    assert.ok((await elevated.query("SELECT count(*)::integer AS n FROM platform_admin_audit WHERE action='infrastructure_read'")).rows[0].n > 0);
  } finally {
    for (const app of apps) await new Promise(resolve => app.close(resolve));
    await writer?.end(); await secondWriter?.end(); await unknownWriter?.end(); await pool?.end(); await elevated?.end();
    await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await owner.query('DROP ROLE IF EXISTS ' + role); await owner.query('DROP ROLE IF EXISTS ' + login);
    await owner.query('DROP ROLE IF EXISTS ' + secondLogin); await owner.query('DROP ROLE IF EXISTS ' + unknownLogin);
    await owner.end();
  }
});
