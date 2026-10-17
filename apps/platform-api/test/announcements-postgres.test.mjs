import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PostgresStore } from '../src/postgres-store.mjs';
import { announcementContract } from './helpers/announcements-contract.mjs';
import { changeAnnouncement, readAnnouncements, readUserAnnouncements } from '../src/announcements/store.mjs';

test('announcements PostgreSQL: contract, least privilege, rollback and concurrency', { skip: !process.env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL }, async t => {
  const connectionString = process.env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL;
  const suffix = randomUUID().replaceAll('-', ''), schema = 'notice_' + suffix, role = 'notice_app_' + suffix;
  const owner = new Pool({ connectionString });
  let elevated, pool, secondPool;
  try {
    await owner.query('CREATE SCHEMA ' + schema);
    await owner.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    elevated = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
    // Exercise real installations that broadly grant application defaults. 041 must strip them.
    await elevated.query('ALTER DEFAULT PRIVILEGES IN SCHEMA ' + schema + ' GRANT ALL ON TABLES TO ' + role);
    await elevated.query('ALTER DEFAULT PRIVILEGES IN SCHEMA ' + schema + ' GRANT ALL ON SEQUENCES TO ' + role);
    await elevated.query('ALTER DEFAULT PRIVILEGES IN SCHEMA ' + schema + ' GRANT EXECUTE ON FUNCTIONS TO ' + role);
    const migrations = ['001_platform_mvp.sql', '022_agent_templates.sql', '023_auth_sessions.sql', '024_worker_rls.sql', '025_client_resources.sql',
      '026_conversation_messages.sql', '027_client_resource_contents.sql', '028_agent_user_features.sql', '029_agent_engine_rls.sql',
      '030_agent_engine_mock_default.sql', '031_multi_organization_reservations.sql', '032_better_auth.sql', '034_platform_admin.sql', '036_account_governance.sql', '037_governance_reason_length.sql', '041_platform_announcements.sql', '042_announcement_admin_search.sql', '043_announcement_default_expiry.sql'];
    for (const name of migrations) await elevated.query(await readFile(new URL('../../../packages/db/migrations/' + name, import.meta.url), 'utf8'));
    await elevated.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
    const signatures = ['platform_announcement_change(text,jsonb)', 'platform_announcement_read(text,jsonb)',
      'platform_announcement_user_read(text,text,jsonb)', 'platform_announcement_mark_read(text,text,uuid)'];
    await elevated.query('GRANT EXECUTE ON FUNCTION ' + signatures.join(',') + ' TO ' + role);
    const config = { connectionString, max: 1, connectionTimeoutMillis: 3000, options: '-c search_path=' + schema + ',public -c role=' + role + ' -c TimeZone=America/New_York' };
    pool = new Pool(config); secondPool = new Pool(config);
    const store = new PostgresStore({ pool }), otherStore = new PostgresStore({ pool: secondPool });
    const ids = ['admin', 'second', 'viewer', 'operator', 'user', 'other'];
    for (const id of ids) {
      await elevated.query('INSERT INTO users(id,email) VALUES($1,$2)', [id, id + '@example.test']);
      await elevated.query("INSERT INTO organizations(id,name,kind) VALUES($1,$1,'personal')", ['org-' + id]);
      await elevated.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'org_admin')", ['org-' + id, id]);
    }
    for (const id of ['admin', 'second', 'viewer', 'operator']) await elevated.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES($1,$2,'fixture','fixture')", [id, 'platform_' + (id === 'second' ? 'admin' : id)]);
    const now = Date.now;
    const create = (extra = {}, actor = 'admin', targetStore = store) => changeAnnouncement(targetStore, actor, { action: 'create', requestId: randomUUID(), title: 'title', body: 'body', ...extra });
    const publish = (item, targetStore = store, requestId = randomUUID()) => changeAnnouncement(targetStore, 'admin', { action: 'publish', id: item.id, expectedVersion: item.version, requestId });
    await announcementContract(t, { store, admin: 'admin', second: 'second', viewer: 'viewer', operator: 'operator', user: 'user', other: 'other', now,
      scope: { userId: 'user', organizationId: 'org-user' }, otherScope: { userId: 'other', organizationId: 'org-other' },
      async govern(id, status) { await elevated.query('INSERT INTO platform_account_governance(user_id,status,version) VALUES($1,$2,1) ON CONFLICT(user_id) DO UPDATE SET status=$2,version=platform_account_governance.version+1', [id, status]); },
      async revoke(id, value) { await elevated.query('UPDATE platform_role_bindings SET revoked_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE user_id=$1', [id, value]); },
      async expire(id) { await elevated.query("UPDATE platform_announcements SET expires_at=clock_timestamp()-interval '1 second',published_at=clock_timestamp()-interval '2 seconds' WHERE id=$1", [id]); },
      async materializeExpired(id) { await elevated.query("UPDATE platform_announcements SET status='expired' WHERE id=$1", [id]); },
    });

    await t.test('direct reads/writes/audit mutation and PUBLIC function access are refused', async () => {
      for (const table of ['platform_announcements', 'platform_announcement_receipts', 'platform_announcement_audit', 'platform_announcement_requests']) {
        await assert.rejects(pool.query('SELECT * FROM ' + table), { code: '42501' });
        await assert.rejects(pool.query('DELETE FROM ' + table), { code: '42501' });
        await assert.rejects(pool.query('TRUNCATE ' + table + ' CASCADE'), { code: '42501' });
        const flags = await elevated.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [table]);
        assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
      }
      assert.equal((await elevated.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND proname LIKE 'platform_announcement%' AND EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')", [schema])).rows[0].n, 0);
      await assert.rejects(pool.query('SELECT platform_announcement_validate($1)', [{}]), { code: '42501' });
      await assert.rejects(pool.query("SELECT nextval('platform_announcement_audit_id_seq')"), { code: '42501' });
    });

    await t.test('direct SQL revalidates malformed commands and queries, not just the JS adapter', async () => {
      for (const input of [null, [], { action: 'create', requestId: randomUUID(), title: 'x', body: '' }, { action: 'create', requestId: randomUUID(), title: 'x', body: 'x', pinned: 'false' },
        { action: 'create', requestId: randomUUID(), title: 'x', body: 'x', actor: 'second' }, { action: 'create', requestId: randomUUID(), title: 'x', body: 'x', expiresAt: '2026-02-30T00:00:00Z' },
        ...['2026-10-16T24:00:00Z', '2026-10-16T23:59:60Z', '2026-10-16T23:00:00+14:30'].map(expiresAt => ({ action: 'create', requestId: randomUUID(), title: 'x', body: 'x', expiresAt }))]) {
        await assert.rejects(pool.query('SELECT platform_announcement_change($1,$2)', ['admin', input]), { code: '22023' });
      }
      for (const query of [{ limit: 101 }, { id: 'invalid' }, { audit: true }, { limit: '5' }, { history: 'true' }, { status: null }, { audit: null }, { after: null }, { limit: null }]) {
        await assert.rejects(pool.query('SELECT platform_announcement_read($1,$2)', ['admin', query]), { code: '22023' });
      }
    });

    await t.test('two independent pools deduplicate create and fence concurrent edits', async () => {
      const input = { action: 'create', requestId: randomUUID(), title: 'race', body: 'body' };
      const results = await Promise.all([store, otherStore].map(s => changeAnnouncement(s, 'admin', input)));
      assert.equal(results[0].announcement.id, results[1].announcement.id);
      assert.equal(results.filter(x => x.replayed).length, 1);
      const draft = results[0].announcement;
      const edits = await Promise.all([store, otherStore].map((s, i) => changeAnnouncement(s, i ? 'second' : 'admin', { action: 'edit', id: draft.id, expectedVersion: 1, requestId: randomUUID(), title: 'changed' + i, body: 'changed' })));
      assert.equal(edits.filter(x => x.announcement).length, 1);
      assert.equal(edits.filter(x => x.error === 'version_conflict').length, 1);
    });

    await t.test('audit failure rolls back publication AND request slot; identical request can then succeed', async () => {
      const draft = (await create()).announcement, requestId = randomUUID();
      await elevated.query("ALTER TABLE platform_announcement_audit ADD CONSTRAINT reject_publication CHECK (action <> 'published') NOT VALID");
      await assert.rejects(publish(draft, store, requestId), { code: 'announcements_unavailable' });
      assert.equal((await readAnnouncements(store, 'admin', { id: draft.id })).announcement.status, 'draft');
      assert.equal((await elevated.query('SELECT count(*)::int n FROM platform_announcement_requests WHERE actor_user_id=$1 AND request_id=$2', ['admin', requestId])).rows[0].n, 0);
      await elevated.query('ALTER TABLE platform_announcement_audit DROP CONSTRAINT reject_publication');
      assert.equal((await publish(draft, store, requestId)).announcement.status, 'published');
    });

    await t.test('migration reapply preserves OIDs/grants, announcements, receipts and audit', async () => {
      const before = await readAnnouncements(store, 'admin', {});
      const grants = async () => (await elevated.query("SELECT oid,proowner,proacl::text FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname LIKE 'platform_announcement%' ORDER BY oid", [schema])).rows;
      const original = await grants();
      await elevated.query(await readFile(new URL('../../../packages/db/migrations/041_platform_announcements.sql', import.meta.url), 'utf8'));
      await elevated.query(await readFile(new URL('../../../packages/db/migrations/042_announcement_admin_search.sql', import.meta.url), 'utf8'));
      await elevated.query(await readFile(new URL('../../../packages/db/migrations/043_announcement_default_expiry.sql', import.meta.url), 'utf8'));
      assert.deepEqual(await grants(), original);
      assert.deepEqual(await readAnnouncements(store, 'admin', {}), before);
    });

    await t.test('governance lock waits before authorization snapshot and blocks a suspended admin', async () => {
      const c = await elevated.connect(); let pending;
      try {
        await c.query('BEGIN');
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [schema + ':governance:changes']);
        await c.query("UPDATE platform_account_governance SET status='suspended',version=version+1 WHERE user_id='admin'");
        let settled = false;
        pending = create().then(x => { settled = true; return x; });
        await new Promise(r => setTimeout(r, 100)); assert.equal(settled, false);
        await c.query('COMMIT');
        assert.equal((await pending).error, 'platform_role_required');
      } finally { await c.query('ROLLBACK'); c.release(); await pending; await elevated.query("UPDATE platform_account_governance SET status='active',version=version+1 WHERE user_id='admin'"); }
    });

    await t.test('role UPDATE waits while announcement mutation holds role shared lock', async () => {
      const c = await elevated.connect(); let pending;
      try {
        await c.query('BEGIN');
        const result = await c.query('SELECT platform_announcement_change($1,$2) AS result', ['admin', { action: 'create', title: 'lock test', body: 'b', requestId: randomUUID() }]);
        assert.ok(result.rows[0].result.announcement);
        let settled = false;
        pending = elevated.query("UPDATE platform_role_bindings SET revoked_at=now() WHERE user_id='admin'").then(x => { settled = true; return x; });
        await new Promise(r => setTimeout(r, 100)); assert.equal(settled, false);
        await c.query('COMMIT'); await pending;
        assert.equal((await create()).error, 'platform_role_required');
      } finally { await c.query('ROLLBACK'); c.release(); await pending; await elevated.query("UPDATE platform_role_bindings SET revoked_at=NULL WHERE user_id='admin'"); }
    });

    await t.test('real governance function waits for in-flight announcement mutation before suspending admin', async () => {
      const c = await elevated.connect(); let pending;
      try {
        await c.query('BEGIN');
        const created = await c.query('SELECT platform_announcement_change($1,$2) AS result', ['admin', { action: 'create', title: 'governance fence', body: 'b', requestId: randomUUID() }]);
        assert.ok(created.rows[0].result.announcement);
        const version = (await elevated.query("SELECT platform_account_access('admin')->>'version' v")).rows[0].v;
        let settled = false;
        pending = elevated.query('SELECT platform_governance_change($1,$2,$3,$4,$5,$6) result', ['second', 'admin', 'suspended', Number(version), 'announcement fencing test', randomUUID()]).then(x => { settled = true; return x; });
        await new Promise(r => setTimeout(r, 100)); assert.equal(settled, false);
        await c.query('COMMIT');
        assert.equal((await pending).rows[0].result.account.status, 'suspended');
        assert.equal((await create()).error, 'platform_role_required');
      } finally { await c.query('ROLLBACK'); c.release(); await pending; await elevated.query("UPDATE platform_account_governance SET status='active',version=version+1 WHERE user_id='admin'"); }
    });

    await t.test('new personal account sees existing effective announcements without fanout rows', async () => {
      const published = (await publish((await create()).announcement)).announcement;
      await elevated.query("INSERT INTO users(id,email) VALUES('new-user','new@example.test')");
      await elevated.query("INSERT INTO organizations(id,name,kind) VALUES('new-org','new','personal')");
      await elevated.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES('new-org','new-user','org_admin')");
      const result = await readUserAnnouncements(store, { userId: 'new-user', organizationId: 'new-org' }, { id: published.id });
      assert.equal(result.announcement.isRead, false);
      assert.equal((await elevated.query("SELECT count(*)::int n FROM platform_announcement_receipts WHERE user_id='new-user'")).rows[0].n, 0);
    });
  } finally {
    await pool?.end(); await secondPool?.end(); await elevated?.end();
    await owner.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await owner.query('DROP ROLE IF EXISTS ' + role); await owner.end();
  }
});
