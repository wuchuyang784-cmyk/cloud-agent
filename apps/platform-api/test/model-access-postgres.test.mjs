import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { EventEmitter } from 'node:events';
import { createCredentialService, issueRuntimeGrant } from '../src/model-access/service.mjs';
let api = {};
try { api = await import('../src/model-access/postgres-store.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const connectionString = process.env.BAIRUI_MODEL_ACCESS_TEST_DATABASE_URL;
test('F2 PostgreSQL adapter exposes only the bounded function-based store', () => { assert.equal(typeof api.PostgresModelAccessStore, 'function'); });
test('F2 adapter sanitizes failures and discards a connection after uncertain COMMIT', async () => {
  const scope = { organizationId: 'org-a', userId: 'user-a' };
  const connectError = new api.PostgresModelAccessStore({ pool: { connect: async () => { throw new Error('private database endpoint'); } } });
  await assert.rejects(connectError.listCredentials(scope), error => error.code === 'model_access_unavailable' && !error.message.includes('private'));
  const client = new EventEmitter(), calls = [];
  let released;
  client.query = async sql => { calls.push(sql); if (sql === 'COMMIT') throw new Error('private uncertain commit'); return { rows: [{ result: [] }] }; };
  client.release = error => { released = error; };
  const store = new api.PostgresModelAccessStore({ pool: { connect: async () => client } });
  await assert.rejects(store.listCredentials(scope), { code: 'model_access_unavailable' });
  assert.ok(released, 'uncertain COMMIT must evict the checked-out connection');
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.ok(calls.includes('ROLLBACK')); assert.equal(client.listenerCount('error'), 0);
});
test('F2 adapter rejects malformed scope, grant and terminal usage before connecting', async () => {
  let connections = 0;
  const store = new api.PostgresModelAccessStore({ pool: { connect: async () => { connections++; throw new Error('must not connect'); } } });
  await assert.rejects(async () => store.listCredentials({ organizationId: 'org-a', userId: 'user-a', admin: true }), { code: 'invalid_model_input' });
  await assert.rejects(async () => store.issueGrant({}), { code: 'invalid_model_input' });
  await assert.rejects(async () => store.finishRequest(randomUUID(), { state: 'failed', inputTokens: 1, outputTokens: 1 }), { code: 'invalid_model_input' });
  await assert.rejects(async () => store.finishRequest(randomUUID(), { state: 'completed', inputTokens: 1, outputTokens: null }), { code: 'invalid_model_input' });
  await assert.rejects(async () => store.createCredential({ organizationId: 'org-a', userId: 'user-a' }, { id: randomUUID(), provider: 'provider-a', label: 'Key', envelope: { version: 1, keyId: 'key-1', wrappedKey: 'plaintext', iv: 'x', ciphertext: 'x', tag: 'x' } }), { code: 'invalid_model_input' });
  assert.equal(connections, 0);
});

test('F2 real PostgreSQL least privilege, parallel admission, revocation and migration rerun', { skip: !connectionString }, async t => {
  const suffix = randomUUID().replaceAll('-', ''), schema = 'model_' + suffix;
  const roles = Object.fromEntries(['app', 'issuer', 'gateway'].map(key => [key, 'model_' + key + '_' + suffix]));
  const admin = new Pool({ connectionString }), owner = new Pool({ connectionString, options: '-c search_path=' + schema + ',public' });
  const pools = {};
  try {
    await admin.query('CREATE SCHEMA ' + schema);
    for (const role of Object.values(roles)) await admin.query('CREATE ROLE ' + role + ' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    const directory = new URL('../../../packages/db/migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      if (name.startsWith('046_')) {
        await owner.query('ALTER DEFAULT PRIVILEGES IN SCHEMA ' + schema + ' GRANT ALL ON TABLES TO ' + roles.app);
        await owner.query('ALTER DEFAULT PRIVILEGES IN SCHEMA ' + schema + ' GRANT EXECUTE ON FUNCTIONS TO ' + roles.app);
      }
      await owner.query(await readFile(new URL(name, directory), 'utf8'));
    }
    assert.ok((await owner.query("SELECT to_regprocedure('model_credential_list(text,text)') result")).rows[0].result, 'F2 migration functions must exist');
    await owner.query(`INSERT INTO organizations(id,name) VALUES('org-a','A'),('org-b','B');
      INSERT INTO users(id,email) VALUES('user-a','a@model.test'),('user-b','b@model.test');
      INSERT INTO organization_members(organization_id,user_id,role) VALUES('org-a','user-a','user'),('org-b','user-b','user');
      INSERT INTO agents(id,organization_id,owner_user_id,name,status,runtime_kind,host,engine,template_version)
        VALUES('agent-a','org-a','user-a','A','ready','pi','agent-a.model.test','pi',1);
      INSERT INTO agent_engine_runs(id,organization_id,agent_id,engine,template_version,status,desired_state,subdomain,run_generation)
        VALUES('run-11111111-1111-4111-8111-111111111111','org-a','agent-a','pi',1,'running','running','agent-a.model.test',1);
      INSERT INTO agent_runtime_controls(agent_id,organization_id,owner_user_id,desired_state,generation,active_run_id,cpu_millis,memory_bytes,pids_limit,idle_ttl_seconds,change_reason)
        VALUES('agent-a','org-a','user-a','running',1,'run-11111111-1111-4111-8111-111111111111',100,134217728,16,60,'F2 fixture');`);
    for (const [kind, role] of Object.entries(roles)) {
      await owner.query('GRANT USAGE ON SCHEMA ' + schema + ' TO ' + role);
      pools[kind] = new Pool({ connectionString, options: '-c search_path=' + schema + ',public -c role=' + role, connectionTimeoutMillis: 2000, query_timeout: 4000, max: 2 });
    }
    await owner.query(`GRANT EXECUTE ON FUNCTION model_credential_list(text,text), model_credential_get(text,text,uuid), model_credential_create(text,text,jsonb), model_credential_rotate(text,text,uuid,integer,jsonb), model_credential_revoke(text,text,uuid,integer) TO ${roles.app}`);
    await owner.query(`GRANT EXECUTE ON FUNCTION model_grant_issue(text,text,jsonb),model_grant_revoke(uuid) TO ${roles.issuer}`);
    await owner.query(`GRANT EXECUTE ON FUNCTION model_request_reserve(text,uuid,text),model_request_finish(uuid,text,bigint,bigint) TO ${roles.gateway}`);
    pools.gatewayReplica = new Pool({ connectionString, options: '-c search_path=' + schema + ',public -c role=' + roles.gateway, connectionTimeoutMillis: 2000, query_timeout: 4000, max: 2 });
    const app = new api.PostgresModelAccessStore({ pool: pools.app }), issuer = new api.PostgresModelAccessStore({ pool: pools.issuer }), gateway = new api.PostgresModelAccessStore({ pool: pools.gateway }), gatewayReplica = new api.PostgresModelAccessStore({ pool: pools.gatewayReplica });
    const keys = generateKeyPairSync('rsa', { modulusLength: 3072 }), scope = { organizationId: 'org-a', userId: 'user-a' }, other = { organizationId: 'org-b', userId: 'user-b' };
    const service = createCredentialService({ store: app, configuration: { keyId: 'key-1', publicKey: keys.publicKey, providers: [{ id: 'provider-a', models: ['model-a'] }] } });
    const credential = await service.create(scope, { provider: 'provider-a', label: 'Private', apiKey: 'fixture-' + 'x'.repeat(30) });
    assert.equal(credential.status, 'active'); assert.doesNotMatch(JSON.stringify(credential), /envelope|ciphertext|fixture-/);
    assert.deepEqual(await service.list(other), []);
    await owner.query("INSERT INTO platform_role_bindings(user_id,role,granted_by,reason) VALUES('user-b','platform_admin','test','F2 scope fixture')");
    await assert.rejects(service.rotate(other, credential.id, { expectedVersion: 1, apiKey: 'fixture-' + 'y'.repeat(30) }), { code: 'model_credential_not_found' });
    const createOther = () => service.create(other, { provider: 'provider-a', label: 'Other', apiKey: 'fixture-' + 'q'.repeat(30) });
    const otherCredentials = [];
    for (let i = 0; i < 19; i++) otherCredentials.push(await createOther());
    const quotaRace = await Promise.allSettled([createOther(), createOther(), createOther()]);
    assert.equal(quotaRace.filter(r => r.status === 'fulfilled').length, 1, 'active credential ceiling is atomic across connections');
    assert.ok(quotaRace.filter(r => r.status === 'rejected').every(r => r.reason.code === 'model_access_conflict'));
    otherCredentials.push(quotaRace.find(r => r.status === 'fulfilled').value);
    for (const c of otherCredentials) await service.revoke(other, c.id, 1);
    for (let i = 0; i < 31; i++) { const c = await createOther(); await service.revoke(other, c.id, 1); }
    assert.equal((await service.list(other)).length, 50, 'metadata listing is bounded including revoked history');
    const newest = await createOther(); assert.equal((await service.list(other))[0].id, newest.id, 'active credentials sort before historical rows');
    const rotations = await Promise.allSettled([service.rotate(other, newest.id, { expectedVersion: 1, apiKey: 'fixture-' + 'v'.repeat(30) }), service.rotate(other, newest.id, { expectedVersion: 1, apiKey: 'fixture-' + 'w'.repeat(30) })]);
    assert.equal(rotations.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(rotations.find(r => r.status === 'rejected').reason.code, 'model_access_conflict');
    for (const table of ['model_credentials', 'model_runtime_grants', 'model_gateway_requests', 'model_access_audit']) {
      for (const kind of ['app', 'issuer', 'gateway']) {
        await assert.rejects(pools[kind].query('SELECT * FROM ' + table), { code: '42501' });
        await assert.rejects(pools[kind].query('TRUNCATE ' + table), { code: '42501' });
      }
      assert.equal((await owner.query('SELECT relrowsecurity AND relforcerowsecurity enabled FROM pg_class WHERE oid=$1::regclass', [table])).rows[0].enabled, true);
      assert.equal((await owner.query("SELECT has_table_privilege($1,$2,'TRUNCATE') allowed", [roles.app, schema + '.' + table])).rows[0].allowed, false);
    }
    await assert.rejects(pools.app.query("SELECT model_grant_issue('org-a','user-a','{}')"), { code: '42501' });
    await assert.rejects(pools.gateway.query("SELECT model_credential_list('org-a','user-a')"), { code: '42501' });
    await assert.rejects(pools.app.query("SELECT model_actor('org-a','user-a',true)"), { code: '42501' });
    await assert.rejects(pools.issuer.query("SELECT model_request_reserve(repeat('a',64),gen_random_uuid(),'model-a')"), { code: '42501' });
    await assert.rejects(pools.app.query("SELECT model_credential_rotate($1,$2,$3,1,$4)", [scope.organizationId, scope.userId, credential.id, { version: 1, keyId: 'key-1', wrappedKey: 'plaintext' }]), { code: '22023' });
    const grantInput = { store: issuer, scope, credentialId: credential.id, agentId: 'agent-a', runId: 'run-11111111-1111-4111-8111-111111111111', runGeneration: 1, model: 'model-a', ttlSeconds: 120, maxRequests: 2 };
    const grant = await issueRuntimeGrant(grantInput), hash = createHash('sha256').update(grant.token).digest('hex');
    const reserve = () => gateway.reserveRequest({ tokenHash: hash, requestId: randomUUID(), model: 'model-a' });
    const attempts = await Promise.allSettled([reserve(), gatewayReplica.reserveRequest({ tokenHash: hash, requestId: randomUUID(), model: 'model-a' })]); assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(attempts.find(row => row.status === 'rejected').reason.code, 'model_gateway_busy');
    const request = attempts.find(row => row.status === 'fulfilled').value;
    await gateway.finishRequest(request.requestId, { state: 'completed', inputTokens: 12, outputTokens: 4 });
    await assert.rejects(gateway.finishRequest(request.requestId, { state: 'completed', inputTokens: 99, outputTokens: 99 }), { code: 'model_access_conflict' });
    const second = await reserve(); await gateway.finishRequest(second.requestId, { state: 'unknown', inputTokens: null, outputTokens: null });
    await assert.rejects(reserve(), { code: 'model_grant_invalid' });
    const oldGrant = await issueRuntimeGrant(grantInput); await service.rotate(scope, credential.id, { expectedVersion: 1, apiKey: 'fixture-' + 'z'.repeat(30) });
    await assert.rejects(gateway.reserveRequest({ tokenHash: createHash('sha256').update(oldGrant.token).digest('hex'), requestId: randomUUID(), model: 'model-a' }), { code: 'model_grant_invalid' });
    // All invalidations inspect the live state again, after issuance.
    const freshInput = { ...grantInput, ttlSeconds: 300, maxRequests: 32 };
    const hashOf = token => createHash('sha256').update(token).digest('hex');
    const reserveGrant = (g, target = gateway) => target.reserveRequest({ tokenHash: hashOf(g.token), requestId: randomUUID(), model: 'model-a' });
    // Verify admission waits behind the actual governance lock, and then reads
    // the new governance version rather than retaining its pre-wait snapshot.
    const lockedGrant = await issueRuntimeGrant(freshInput), blocker = await owner.connect(), admissionClient = await pools.gatewayReplica.connect();
    const admissionPid = (await admissionClient.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    let admission;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [schema + ':governance:changes']);
      await blocker.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES('user-a','active',1)");
      const waitingStore = new api.PostgresModelAccessStore({ pool: { connect: async () => admissionClient } });
      admission = reserveGrant(lockedGrant, waitingStore).then(value => ({ value }), error => ({ error }));
      let waiting = false;
      const deadline = Date.now() + 800;
      while (Date.now() < deadline) {
        waiting = (await owner.query('SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) waiting', [admissionPid])).rows[0].waiting;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(waiting, true, 'admission shares the same governance lock as D1/E1');
      await blocker.query('COMMIT');
      assert.equal((await admission).error?.code, 'model_grant_invalid');
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      if (admission) await admission; else admissionClient.release();
      await owner.query('DELETE FROM platform_account_governance');
    }
    const mutations = [
      ["UPDATE agent_runtime_controls SET desired_state='stopped'", "UPDATE agent_runtime_controls SET desired_state='running'"],
      ['UPDATE agent_runtime_controls SET generation=2', 'UPDATE agent_runtime_controls SET generation=1'],
      ['UPDATE agent_runtime_controls SET governance_version=1', 'UPDATE agent_runtime_controls SET governance_version=0'],
      ['UPDATE agent_runtime_controls SET active_run_id=NULL', "UPDATE agent_runtime_controls SET active_run_id='run-11111111-1111-4111-8111-111111111111'"],
      ["UPDATE agent_engine_runs SET engine='dsh'", "UPDATE agent_engine_runs SET engine='pi'"],
      ["UPDATE agent_engine_runs SET status='initializing'", "UPDATE agent_engine_runs SET status='running'"],
      ["UPDATE agents SET owner_user_id='user-b'", "UPDATE agents SET owner_user_id='user-a'"],
      ["INSERT INTO platform_account_governance(user_id,status,version) VALUES('user-a','suspended',1)", 'DELETE FROM platform_account_governance'],
      ["INSERT INTO platform_account_governance(user_id,status,version) VALUES('user-a','active',1)", 'DELETE FROM platform_account_governance'],
    ];
    for (const [invalidate, restore] of mutations) {
      const g = await issueRuntimeGrant(freshInput);
      await owner.query(invalidate);
      try { await assert.rejects(reserveGrant(g), { code: 'model_grant_invalid' }); }
      finally { await owner.query(restore); }
    }
    const initialGrant = await issueRuntimeGrant(freshInput);
    await owner.query("UPDATE agent_engine_runs SET status='initializing'");
    assert.ok((await issueRuntimeGrant(freshInput)).grantId, 'initializing run allows issuance but not admission');
    await owner.query("UPDATE agent_engine_runs SET status='running'");
    await issuer.revokeGrant(initialGrant.grantId); await assert.rejects(reserveGrant(initialGrant), { code: 'model_grant_invalid' });

    const ga = await issueRuntimeGrant(freshInput), gb = await issueRuntimeGrant(freshInput);
    const crossGrantAttempts = await Promise.allSettled([reserveGrant(ga), reserveGrant(gb, gatewayReplica)]);
    assert.equal(crossGrantAttempts.filter(r => r.status === 'fulfilled').length, 1, 'one active call per run across grants and replicas');
    const active = crossGrantAttempts.find(r => r.status === 'fulfilled').value;
    await owner.query("UPDATE model_gateway_requests SET started_at=started_at-interval '126 seconds',lease_until=lease_until-interval '126 seconds' WHERE request_id=$1", [active.requestId]);
    const replacement = await reserveGrant(ga);
    assert.equal((await owner.query('SELECT state FROM model_gateway_requests WHERE request_id=$1', [active.requestId])).rows[0].state, 'unknown');
    await assert.rejects(gateway.finishRequest(active.requestId, { state: 'completed', inputTokens: 4, outputTokens: 1 }), { code: 'model_access_conflict' });
    // Stop/governance changes after admission do not prevent a terminal receipt.
    await owner.query("UPDATE agent_runtime_controls SET desired_state='stopped'");
    await gateway.finishRequest(replacement.requestId, { state: 'failed', inputTokens: null, outputTokens: null });
    await owner.query("UPDATE agent_runtime_controls SET desired_state='running'");
    const late = await reserveGrant(gb);
    await owner.query("UPDATE model_gateway_requests SET started_at=started_at-interval '126 seconds',lease_until=lease_until-interval '126 seconds' WHERE request_id=$1", [late.requestId]);
    await assert.rejects(gateway.finishRequest(late.requestId, { state: 'completed', inputTokens: 4, outputTokens: 1 }), { code: 'model_access_conflict' });
    assert.equal((await owner.query('SELECT state FROM model_gateway_requests WHERE request_id=$1', [late.requestId])).rows[0].state, 'unknown');
    const expired = await issueRuntimeGrant(freshInput);
    await owner.query("UPDATE model_runtime_grants SET issued_at=issued_at-interval '301 seconds',expires_at=expires_at-interval '301 seconds' WHERE id=$1", [expired.grantId]);
    await assert.rejects(reserveGrant(expired), { code: 'model_grant_invalid' });
    const usageGrant = await issueRuntimeGrant(freshInput), usage = await reserveGrant(usageGrant);
    await assert.rejects(gatewayReplica.reserveRequest({ tokenHash: hashOf(usageGrant.token), requestId: randomUUID(), model: 'wrong-model' }), { code: 'model_grant_invalid' });
    for (const values of [[1, null], [-1, 0], [9007199254740992n, 0]]) {
      await assert.rejects(pools.gateway.query("SELECT model_request_finish($1,'completed',$2,$3)", [usage.requestId, ...values]), { code: '22023' });
    }
    await assert.rejects(pools.gateway.query("SELECT model_request_finish($1,'failed',1,1)", [usage.requestId]), { code: '22023' });
    await gateway.finishRequest(usage.requestId, { state: 'completed', inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
    await assert.rejects(gateway.reserveRequest({ tokenHash: hashOf(usageGrant.token), requestId: usage.requestId, model: 'model-a' }), { code: 'model_access_conflict' });
    assert.equal((await owner.query('SELECT used_requests FROM model_runtime_grants WHERE id=$1', [usageGrant.grantId])).rows[0].used_requests, 1, 'wrong model and replay never consume extra quota');
    assert.equal((await owner.query('SELECT input_tokens::text value FROM model_gateway_requests WHERE request_id=$1', [usage.requestId])).rows[0].value, String(Number.MAX_SAFE_INTEGER));
    const revokedCredentialGrant = await issueRuntimeGrant(freshInput);
    await service.revoke(scope, credential.id, 2);
    await assert.rejects(reserveGrant(revokedCredentialGrant), { code: 'model_grant_invalid' });
    await assert.rejects(issueRuntimeGrant(freshInput), { code: 'model_grant_invalid' });
    // Issuer revocation remains possible after an account is banned.
    await owner.query("INSERT INTO platform_account_governance(user_id,status,version) VALUES('user-a','banned',1)");
    await issuer.revokeGrant(gb.grantId); await assert.rejects(service.list(scope), { code: 'model_access_denied' });
    await owner.query("UPDATE platform_account_governance SET status='suspended'");
    assert.equal((await service.list(scope)).length, 1);
    await assert.rejects(service.create(scope, { provider: 'provider-a', label: 'x', apiKey: 'fixture-' + 'x'.repeat(30) }), { code: 'model_access_denied' });
    await owner.query('DELETE FROM platform_account_governance');
    assert.doesNotMatch(JSON.stringify((await owner.query('SELECT * FROM model_access_audit')).rows), /fixture-|envelope|ciphertext|token_hash|tokenHash|wrappedKey/);
    const countBefore = Number((await owner.query('SELECT count(*) count FROM model_gateway_requests')).rows[0].count);
    await owner.query(await readFile(new URL('046_model_access.sql', directory), 'utf8'));
    // Reapplying the migration preserves deliberate least-privilege function grants.
    assert.equal((await service.list(scope))[0].version, 3);
    assert.equal(Number((await owner.query('SELECT count(*) count FROM model_gateway_requests')).rows[0].count), countBefore);
    await issuer.revokeGrant(ga.grantId); // Preserved issuer grant, not just list.
    await assert.rejects(reserveGrant(ga), { code: 'model_grant_invalid' }); // Preserved gateway grant.
  } finally {
    for (const pool of Object.values(pools)) await pool.end(); await owner.end();
    await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    for (const role of Object.values(roles)) await admin.query('DROP ROLE IF EXISTS ' + role);
    await admin.end();
  }
});
