import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPublisherFixture } from './helpers/announcement-publisher-fixture.mjs';
import { publisherContract } from './helpers/announcement-publisher-contract.mjs';
import { publisherTick } from '../src/announcements/publisher-store.mjs';
import { changeAnnouncement, readAnnouncements } from '../src/announcements/store.mjs';

test('announcement publisher restricted PostgreSQL, concurrency and recovery', { skip: !process.env.BAIRUI_ANNOUNCEMENT_TEST_DATABASE_URL }, async t => {
  const f = await createPublisherFixture();
  const machine = { pool: f.publisherPool };
  try {
    await publisherContract(t, { store: f.appStore, publisherStore: machine, now: Date.now, due: f.due,
      async expire(id) { await f.elevated.query("UPDATE platform_announcements SET published_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]); },
      async restrict(reason,on) {
        if (['governance','generation'].includes(reason)) await f.elevated.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES('admin',$1,1) ON CONFLICT(user_id) DO UPDATE SET status=$1,version=platform_account_governance.version+1", [reason === 'governance' && on?'suspended':'active']);
        else if (reason === 'role') await f.elevated.query("UPDATE platform_role_bindings SET role=$1 WHERE user_id='admin'", [on?'platform_viewer':'platform_admin']);
        else await f.elevated.query("UPDATE platform_role_bindings SET revoked_at=CASE WHEN $1 THEN clock_timestamp() ELSE NULL END WHERE user_id='admin'", [on]);
      },
      async failAudit(id,on) {
        if (on) await f.elevated.query("ALTER TABLE platform_announcement_audit ADD CONSTRAINT fail_system_audit CHECK (NOT (announcement_id='"+id+"'::uuid AND executor_type='system')) NOT VALID");
        else await f.elevated.query('ALTER TABLE platform_announcement_audit DROP CONSTRAINT fail_system_audit');
      },
      async retry(id) { await f.elevated.query("UPDATE platform_announcements SET next_publish_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]); },
      async receipts() { return (await f.elevated.query('SELECT count(*)::int n FROM platform_announcement_receipts')).rows[0].n; },
    });
    await t.test('restricted LOGIN has no table/admin/user authority and application has no publisher authority', async () => {
      assert.equal((await f.publisherPool.query('SELECT session_user u')).rows[0].u, f.publisherRole);
      for (const table of ['platform_announcements','platform_announcement_audit','platform_announcement_requests','platform_announcement_receipts','platform_role_bindings','users']) {
        await assert.rejects(f.publisherPool.query('SELECT * FROM '+table), { code:'42501' });
        await assert.rejects(f.publisherPool.query('DELETE FROM '+table), { code:'42501' });
        await assert.rejects(f.publisherPool.query('TRUNCATE '+table+' CASCADE'), { code:'42501' });
      }
      await assert.rejects(f.publisherPool.query('SELECT platform_announcement_change($1,$2)', ['admin',{}]), { code:'42501' });
      for (const fn of ['platform_announcement_publisher_tick(50)','platform_announcement_publisher_status()']) await assert.rejects(f.appPool.query('SELECT '+fn), { code:'42501' });
      for (const limit of [0,51,null]) await assert.rejects(f.publisherPool.query('SELECT platform_announcement_publisher_tick($1)', [limit]), { code:'22023' });
      const status = (await f.publisherPool.query('SELECT platform_announcement_publisher_status() r')).rows[0].r;
      assert.deepEqual(Object.keys(status).sort(), ['processed','published','expired','blocked','failed','pending','maxDelaySeconds','blockedTotal'].sort());
    });
    await t.test('two publisher pools commit exactly one publication and survive replacement of the JS store', async () => {
      const a = await f.schedule(); await f.due(a.id);
      const results = await Promise.all([machine,{pool:f.secondPublisherPool}].map(s => publisherTick(s)));
      assert.equal(results.reduce((n,r)=>n+r.published,0),1);
      assert.equal((await f.elevated.query("SELECT count(*)::int n FROM platform_announcement_audit WHERE announcement_id=$1 AND action='published'",[a.id])).rows[0].n,1);
      assert.equal((await publisherTick({pool:f.secondPublisherPool})).published,0);
    });
    await t.test('held earliest responsible role cannot starve a later administrator when batch limit is one', async () => {
      const first = await f.schedule(), draft = await f.create();
      const later = (await changeAnnouncement(f.appStore,'second',{action:'schedule',id:draft.id,expectedVersion:draft.version,
        requestId:randomUUID(),scheduledAt:new Date(Date.now()+60000).toISOString()})).announcement;
      await f.due(first.id); await f.due(later.id);
      await f.elevated.query("UPDATE platform_announcements SET scheduled_at=clock_timestamp()-CASE WHEN id=$1 THEN interval '20 seconds' ELSE interval '10 seconds' END WHERE id=ANY($2::uuid[])",[first.id,[first.id,later.id]]);
      const c = await f.elevated.connect();
      try {
        await c.query('BEGIN'); await c.query("SELECT user_id FROM platform_role_bindings WHERE user_id='admin' FOR UPDATE");
        const result = await publisherTick(machine,{limit:1});
        assert.equal(result.published,1); assert.equal(result.failed,0); assert.ok(result.pending>=1); assert.ok(result.maxDelaySeconds>=20);
        assert.equal((await readAnnouncements(f.appStore,'second',{id:later.id})).announcement.status,'published');
        const pending=(await readAnnouncements(f.appStore,'second',{id:first.id})).announcement;
        assert.equal(pending.status,'scheduled'); assert.equal(pending.publishAttempts,0); assert.equal(pending.lastPublishError,null);
        // Keep the role held beyond the store's 2s lock timeout, including a second independent machine pool.
        await new Promise(resolve=>setTimeout(resolve,2100));
        assert.equal((await publisherTick({pool:f.secondPublisherPool},{limit:1})).processed,0);
        await c.query('ROLLBACK'); assert.equal((await publisherTick(machine,{limit:1})).published,1);
      } finally { await c.query('ROLLBACK'); c.release(); }
    });
    await t.test('SKIP LOCKED permits another due item to publish while cancellation owns a row; committed cancel cannot be published', async () => {
      const a = await f.schedule(), b = await f.schedule(); await f.due(a.id); await f.due(b.id);
      const c = await f.appPool.connect();
      try {
        await c.query('BEGIN');
        const cancelled = await c.query('SELECT platform_announcement_change($1,$2) r', ['second',{action:'cancel',id:a.id,expectedVersion:a.version,requestId:randomUUID()}]);
        assert.equal(cancelled.rows[0].r.announcement.status,'draft');
        assert.equal((await publisherTick(machine)).published,1);
        await c.query('COMMIT');
        assert.equal((await publisherTick(machine)).published,0);
        assert.equal((await readAnnouncements(f.appStore,'second',{id:a.id})).announcement.status,'draft');
      } finally { await c.query('ROLLBACK'); c.release(); }
    });
    await t.test('publisher transaction fences a concurrent cancellation; stale version is refused after commit', async () => {
      const a = await f.schedule(); await f.due(a.id);
      const c = await f.publisherPool.connect(); let pending;
      try {
        await c.query('BEGIN'); assert.equal((await c.query('SELECT platform_announcement_publisher_tick(50) r')).rows[0].r.published,1);
        let settled=false;
        pending=changeAnnouncement(f.appStore,'second',{action:'cancel',id:a.id,expectedVersion:a.version,requestId:randomUUID()}).then(r=>{settled=true;return r;});
        await new Promise(r=>setTimeout(r,100)); assert.equal(settled,false);
        await c.query('COMMIT'); assert.equal((await pending).error,'version_conflict');
      } finally { await c.query('ROLLBACK'); c.release(); await pending; }
    });
    for (const kind of ['governance','role']) await t.test(kind+' lock wins first: publisher reevaluates after the governance wait or nonblocking role skip', async () => {
      const a = await f.schedule(); await f.due(a.id);
      const c = await f.elevated.connect(); let pending;
      try {
        await c.query('BEGIN');
        if (kind==='governance') {
          await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.schema+':governance:changes']);
          await c.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES('admin','suspended',1) ON CONFLICT(user_id) DO UPDATE SET status='suspended',version=platform_account_governance.version+1");
        } else await c.query("UPDATE platform_role_bindings SET revoked_at=clock_timestamp() WHERE user_id='admin'");
        let settled=false; pending=publisherTick(machine).then(r=>{settled=true;return r;});
        if (kind==='role') {
          assert.equal((await pending).processed,0);
          await c.query('COMMIT'); assert.equal((await publisherTick(machine)).blocked,1);
        } else {
          await new Promise(r=>setTimeout(r,100)); assert.equal(settled,false);
          await c.query('COMMIT'); assert.equal((await pending).blocked,1);
        }
        assert.equal((await readAnnouncements(f.appStore,'second',{id:a.id})).announcement.publishBlocked,true);
      } finally {
        await c.query('ROLLBACK'); c.release(); await pending;
        await f.elevated.query("UPDATE platform_account_governance SET status='active',version=version+1 WHERE user_id='admin'");
        await f.elevated.query("UPDATE platform_role_bindings SET revoked_at=NULL WHERE user_id='admin'");
        // Remove the already-tested blocked item from later race results via normal cancellation.
        const current=(await readAnnouncements(f.appStore,'second',{id:a.id})).announcement;
        await changeAnnouncement(f.appStore,'second',{action:'cancel',id:a.id,expectedVersion:current.version,requestId:randomUUID()});
      }
    });
    for (const kind of ['governance','role']) await t.test('publisher wins first: '+kind+' change waits for committed publication', async () => {
      const a=await f.schedule(); await f.due(a.id);
      const c=await f.publisherPool.connect(); let pending;
      try {
        await c.query('BEGIN'); assert.equal((await c.query('SELECT platform_announcement_publisher_tick(50) r')).rows[0].r.published,1);
        let settled=false;
        if(kind==='governance') {
          const version=Number((await f.elevated.query("SELECT platform_account_access('admin')->>'version' v")).rows[0].v);
          pending=f.elevated.query('SELECT platform_governance_change($1,$2,$3,$4,$5,$6) r',['second','admin','suspended',version,'publisher test',randomUUID()]).then(r=>{settled=true;return r;});
        } else pending=f.elevated.query("UPDATE platform_role_bindings SET revoked_at=clock_timestamp() WHERE user_id='admin'").then(r=>{settled=true;return r;});
        await new Promise(r=>setTimeout(r,100)); assert.equal(settled,false);
        await c.query('COMMIT'); await pending;
        assert.equal((await readAnnouncements(f.appStore,'second',{id:a.id})).announcement.status,'published');
      } finally {
        await c.query('ROLLBACK'); c.release(); await pending;
        await f.elevated.query("UPDATE platform_account_governance SET status='active',version=version+1 WHERE user_id='admin'");
        await f.elevated.query("UPDATE platform_role_bindings SET revoked_at=NULL WHERE user_id='admin'");
      }
    });
    await t.test('migration reapply keeps function OIDs and explicit restricted grants plus all history', async () => {
      const snapshot=async()=>(await f.elevated.query("SELECT oid,proowner,proacl::text FROM pg_proc WHERE pronamespace=$1::regnamespace AND proname LIKE 'platform_announcement%' ORDER BY oid",[f.schema])).rows;
      const before=await snapshot();
      const state=await readAnnouncements(f.appStore,'second',{});
      await f.elevated.query(await readFile(new URL('../../../packages/db/migrations/045_announcement_publisher.sql',import.meta.url),'utf8'));
      assert.deepEqual(await snapshot(),before); assert.deepEqual(await readAnnouncements(f.appStore,'second',{}),state);
      assert.equal((await f.elevated.query("SELECT count(*)::int n FROM pg_proc p WHERE p.pronamespace=$1::regnamespace AND p.proname LIKE 'platform_announcement%' AND EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE')",[f.schema])).rows[0].n,0);
    });
  } finally { await f.close(); }
});
