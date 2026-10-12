import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function assertProbeIdentity(info, state, run) {
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.match(run.containerRef, /^[a-f0-9]{64}$/, 'probe_full_container_id_required');
  assert.equal(info?.Id, run.containerRef, 'probe_container_id_mismatch');
  const labels = info.Config?.Labels;
  assert.equal(labels?.['io.bairui.orchestrator.installation'], state.installation, 'probe_owner_mismatch');
  assert.equal(labels?.['io.bairui.orchestrator.run'], hash(run.runId), 'probe_run_mismatch');
  assert.equal(labels?.['io.bairui.orchestrator.identity'], hash(JSON.stringify([run.agentId, run.runId, run.runGeneration])), 'probe_identity_mismatch');
  assert.equal(labels?.['io.bairui.orchestrator.profile'], 'isolation-probe-v1', 'probe_profile_mismatch');
}
export function fixedMetric(body, name) {
  assert.ok(['controller_cycle_ok', 'controller_last_success_timestamp_seconds', 'active', 'stopping', 'stop_overdue', 'dead_pending', 'observation_errors', 'observation_stale'].includes(name), 'metric_name_invalid');
  const prefix = 'bairui_runtime_' + name;
  const rows = body.split(/\r?\n/).filter(line => line.startsWith(prefix + ' ') || line.startsWith(prefix + '{'));
  assert.equal(rows.length, 1, 'metric_missing_or_duplicate');
  const match = new RegExp('^' + prefix + ' ([0-9]+(?:\\.[0-9]+)?)$').exec(rows[0]);
  assert.ok(match, 'metric_identity_or_value_invalid');
  const value = Number(match[1]);
  assert.ok(Number.isFinite(value) && value >= 0, 'metric_value_invalid');
  return value;
}
export function receivedRuntimeAlert(records, status, after) {
  assert.ok(['firing', 'resolved'].includes(status));
  assert.ok(Number.isFinite(after));
  const runtime = records.filter(record => record.alertname === 'RuntimeControllerUnavailable');
  assert.ok(runtime.every(record => record.instance === null), 'runtime_alert_identity_leak');
  return runtime.some(record => record.status === status && Date.parse(record.receivedAt) >= after);
}

export function testAcceptanceHelpers() {
  const installation = 'a'.repeat(24), runId = 'run-' + randomUUID(), agentId = 'e3-test-' + randomBytes(8).toString('hex');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const run = { runId, agentId, runGeneration: 1, containerRef: 'b'.repeat(64) };
  const info = { Id: run.containerRef, Config: { Labels: {
    'io.bairui.orchestrator.installation': installation,
    'io.bairui.orchestrator.run': hash(runId),
    'io.bairui.orchestrator.identity': hash(JSON.stringify([agentId, runId, 1])),
    'io.bairui.orchestrator.profile': 'isolation-probe-v1',
  } } };
  assert.doesNotThrow(() => assertProbeIdentity(info, { installation }, run));
  assert.throws(() => assertProbeIdentity({ ...info, Id: 'b'.repeat(12) }, { installation }, run));
  assert.throws(() => assertProbeIdentity(info, { installation: 'c'.repeat(24) }, run));
  assert.throws(() => assertProbeIdentity(info, { installation }, { ...run, runGeneration: 2 }));
  assert.equal(fixedMetric('# HELP ignored\nbairui_runtime_controller_cycle_ok 1\nbairui_runtime_active 2\n', 'active'), 2);
  assert.throws(() => fixedMetric('bairui_runtime_active NaN\n', 'active'));
  assert.throws(() => fixedMetric('bairui_runtime_active 1\nbairui_runtime_active 2\n', 'active'));
  assert.throws(() => fixedMetric('bairui_runtime_active{identity="hidden"} 1\n', 'active'));
  assert.throws(() => fixedMetric('bairui_runtime_active 1\n', 'arbitrary.*'));
  const record = { alertname: 'RuntimeControllerUnavailable', status: 'firing', receivedAt: '2026-10-10T00:00:01.000Z', instance: null };
  assert.equal(receivedRuntimeAlert([record], 'firing', Date.parse('2026-10-10T00:00:00Z')), true);
  assert.equal(receivedRuntimeAlert([record], 'firing', Date.parse('2026-10-10T00:00:02Z')), false);
  assert.equal(receivedRuntimeAlert([record], 'resolved', 0), false);
  assert.throws(() => receivedRuntimeAlert([{ ...record, instance: 'unsafe' }], 'firing', 0));
  console.log('E3 常驻验收纯函数：身份围栏、固定指标、告警时间界限通过。');
}

// This acceptance creates only new, explicitly marked PREPRODUCTION records.
// Business credentials, Better Auth accounts, existing roles and Agents are never changed.
export async function testRuntimeDeployment() {
  const { runtimeSql, runtimeOwned, loadRuntimeState } = await import('./runtime-deployment.mjs');
  const { runtimeNames } = await import('./runtime-deployment-config.mjs');
  const { docker, inspect, containers, loadState, request, waitUntil, root } = await import('./preprod.mjs');
  const { alertRecords } = await import('./monitoring.mjs');
  const { monitorNames } = await import('./monitoring-config.mjs');
  const environment = 'preprod', names = runtimeNames(environment), state = await loadRuntimeState(environment);
  const preprod = await loadState();
  assert.equal(state?.phase, 'ready', 'preprod_runtime_not_ready');
  assert.equal(preprod?.runtime?.enabled, true, 'preprod_runtime_not_enabled');
  assert.equal(preprod.runtime.installation, state.installation, 'preprod_runtime_installation_mismatch');
  assert.equal(preprod.monitoring?.runtime?.enabled, true, 'runtime_monitoring_not_enabled');
  assert.ok(preprod.monitoring.runtime.environments.includes(environment), 'preprod_scrape_missing');
  const suffix = randomBytes(12).toString('hex');
  const ids = { org: 'e3-accept-org-' + suffix, user: 'e3-accept-user-' + suffix,
    admin: 'e3-accept-admin-' + suffix, agent: 'e3-accept-agent-' + suffix };
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
  const sql = (statement, database) => runtimeSql(environment, statement, database);
  const json = async (statement, database) => JSON.parse(await sql(statement, database));
  const report = { version: 1, environment, profile: 'isolation-probe-v1', startedAt: new Date().toISOString(), success: false, checks: {} };
  let stage = 'preconditions', seeded = false, controllerPaused = false, controllerId;
  let failure, cleanupFailure;
  const done = name => { report.checks[name] = true; console.log('E3 常驻预发验收：' + name); };
  const snapshot = async (runId = null) => json(`SELECT json_build_object(
    'generation',c.generation,'desiredState',c.desired_state,'activeRunId',c.active_run_id,
    'agentStatus',a.status,'routeCount',(SELECT count(*) FROM runtime_routes WHERE agent_id=a.id),
    'runCount',(SELECT count(*) FROM agent_engine_runs WHERE agent_id=a.id),
    'recoveryAudit',(SELECT count(*) FROM agent_runtime_control_requests WHERE agent_id=a.id AND action='recovery_stop'),
    'governanceStopAudit',(SELECT count(*) FROM agent_runtime_control_requests WHERE agent_id=a.id AND action='governance_stop'),
    'run',CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object('runId',r.id,'agentId',r.agent_id,
      'runGeneration',r.run_generation,'containerRef',r.container_ref,'status',r.status,
      'desiredState',r.desired_state,'stopConfirmed',r.stop_confirmed_at IS NOT NULL) END)
    FROM agents a LEFT JOIN agent_runtime_controls c ON c.agent_id=a.id
    LEFT JOIN agent_engine_runs r ON r.id=${runId ? quote(runId) : 'c.active_run_id'} WHERE a.id=${quote(ids.agent)};`);
  const controller = async () => {
    const item = await runtimeOwned('container', names.controller, state);
    assert.ok(item, 'preprod_controller_missing');
    if (controllerId) assert.equal(item.Id, controllerId, 'controller_replaced_during_acceptance');
    return item;
  };
  const metrics = async ({ authorized = true } = {}) => {
    const item = await controller();
    // Read the token inside the container; neither argv nor returned data contains it.
    const code = `const fs=require('node:fs');const c=JSON.parse(fs.readFileSync('/config/controller.json'));
      fetch('http://127.0.0.1:9495/metrics',{headers:${authorized ? "{Authorization:'Bearer '+fs.readFileSync(c.BAIRUI_RUNTIME_CONTROLLER_METRICS_TOKEN_FILE,'utf8').trim()}" : '{}'},
        signal:AbortSignal.timeout(4000)}).then(async r=>console.log(JSON.stringify({status:r.status,text:await r.text()})))
      .catch(()=>{console.error('metrics_request_failed');process.exitCode=1});`;
    return JSON.parse(await docker(['exec', item.Id, 'node', '-e', code], { timeout: 10000 }));
  };
  const apiHealthy = async () => {
    const response = await request('/readyz', { timeout: 5000 });
    assert.equal(response.status, 200, 'api_not_ready');
    assert.equal(JSON.parse(response.text).database, 'postgres', 'api_postgres_not_ready');
  };
  const prometheusAggregate = async expression => {
    const rows = await containers(monitorNames.prometheus, preprod);
    assert.equal(rows.length, 1, 'prometheus_instance_missing');
    // Internal, fixed aggregate queries only. Raw series/instance identities
    // never enter the report and the browser cannot choose an expression.
    const result = JSON.parse(await docker(['exec', rows[0].Id, 'wget', '-q', '-O', '-',
      'http://127.0.0.1:9090/api/v1/query?query=' + encodeURIComponent(expression)], { timeout: 10000 }));
    assert.equal(result.status, 'success', 'prometheus_query_failed');
    assert.equal(result.data?.result?.length, 1, 'prometheus_aggregate_missing');
    const value = Number(result.data.result[0].value[1]);
    assert.ok(Number.isFinite(value) && value >= 0, 'prometheus_aggregate_invalid');
    return value;
  };
  const start = async expected => {
    const result = await json(`SELECT runtime_control_request_start(${quote(ids.user)},${quote(ids.agent)},'${randomUUID()}',${expected},200,134217728,32,60);`);
    assert.equal(result.result, 'accepted', 'runtime_start_not_accepted');
    assert.match(result.runId, /^run-[a-f0-9-]{36}$/);
    return waitUntil(async () => {
      const current = await snapshot(result.runId);
      if (current.run?.status !== 'running') return false;
      assert.equal(current.activeRunId, result.runId, 'active_run_identity_changed');
      assert.equal(current.generation, result.generation, 'control_generation_changed');
      assert.equal(current.run.runGeneration, result.generation, 'run_generation_changed');
      assert.equal(current.desiredState, 'running');
      assert.equal(current.routeCount, 1, 'running_route_missing');
      assert.match(current.run.containerRef, /^[a-f0-9]{64}$/);
      return current;
    }, '预发真实 run 启动', 90000);
  };
  const terminal = async run => waitUntil(async () => {
    const current = await snapshot(run.runId);
    if (current.activeRunId !== null || current.run?.status !== 'stopped') return false;
    assert.equal(current.desiredState, 'stopped');
    assert.equal(current.agentStatus, 'stopped');
    assert.equal(current.routeCount, 0, 'stopped_route_remaining');
    assert.equal(current.run.stopConfirmed, true, 'unconfirmed_stop');
    // A successful complete-ID listing, rather than an HTTP/CLI timeout, proves deletion.
    const remaining = await docker(['ps', '-a', '--no-trunc', '--filter', 'id=' + run.containerRef, '--format', '{{.ID}}'], { timeout: 10000 });
    if (remaining) {
      assertProbeIdentity(await inspect('container', run.containerRef), state, run);
      return false;
    }
    return current;
  }, '预发真实容器停止与状态回流', 180000);
  const governance = async status => {
    const prior = await json(`SELECT platform_account_access(${quote(ids.user)});`);
    const result = await json(`SELECT platform_governance_change(${quote(ids.admin)},${quote(ids.user)},${quote(status)},${prior.version},'E3验收治理闭环','${randomUUID()}');`);
    assert.equal(result.account?.status, status, 'test_governance_change_failed');
    return result.account;
  };
  try {
    controllerId = (await controller()).Id;
    for (const kind of ['controller', 'orchestrator']) {
      const item = await runtimeOwned('container', names[kind], state);
      assert.ok(item, 'runtime_container_missing');
      assert.equal(item.State.Health?.Status, 'healthy', 'runtime_container_unhealthy');
      assert.equal(item.HostConfig.RestartPolicy.Name, 'unless-stopped');
      assert.equal(item.HostConfig.Init, true, 'runtime_init_process_missing');
      assert.equal(Object.keys(item.HostConfig.PortBindings ?? {}).length, 0);
    }
    await apiHealthy();
    const privileges = await json(`SELECT json_build_object(
      'controllerRestricted',NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole,
      'appCannotStart',NOT has_function_privilege('bairui_preprod_app','runtime_control_request_start(text,text,uuid,bigint,integer,bigint,integer,integer)','EXECUTE'),
      'appCannotStop',NOT has_function_privilege('bairui_preprod_app','runtime_control_request_stop(text,text,uuid,bigint,text)','EXECUTE'))
      FROM pg_roles r WHERE r.rolname='bairui_runtime_controller';`);
    assert.deepEqual(privileges, { controllerRestricted: true, appCannotStart: true, appCannotStop: true });
    const denied = await metrics({ authorized: false });
    assert.equal(denied.status, 401, 'controller_metrics_unauthenticated');
    done('managed_health_and_least_privilege');

    stage = 'seed_test_records';
    await sql(`BEGIN;
      INSERT INTO organizations(id,name) VALUES(${quote(ids.org)},'E3验收 ${suffix}');
      INSERT INTO users(id,email,display_name) VALUES
        (${quote(ids.user)},'e3-accept-${suffix}@example.test','E3验收用户 ${suffix}'),
        (${quote(ids.admin)},'e3-accept-admin-${suffix}@example.test','E3验收管理员 ${suffix}');
      INSERT INTO organization_members(organization_id,user_id,role) VALUES(${quote(ids.org)},${quote(ids.user)},'user');
      INSERT INTO platform_role_bindings(user_id,role,granted_by,reason)
        VALUES(${quote(ids.admin)},'platform_admin','E3 managed acceptance','E3验收独立测试账号');
      INSERT INTO agents(id,organization_id,owner_user_id,name,status,runtime_kind,engine,template_version,host)
        VALUES(${quote(ids.agent)},${quote(ids.org)},${quote(ids.user)},'E3验收固定无模型探针 ${suffix}','stopped','pi','pi',1,'e3-accept-${suffix}.localhost');
      COMMIT;`);
    seeded = true;
    assert.equal(await sql(`SELECT count(*) FROM users WHERE id IN (${quote(ids.user)},${quote(ids.admin)}) AND auth_subject IS NULL;`), '2');
    done('isolated_test_records_without_credentials');

    stage = 'actual_probe_policy';
    const first = await start(0), probe = await inspect('container', first.run.containerRef);
    assertProbeIdentity(probe, state, first.run);
    assert.equal(probe.State.Running, true);
    assert.equal(probe.Image, state.probeImage);
    assert.equal(probe.Config.User, '1000:1000');
    assert.equal(probe.HostConfig.ReadonlyRootfs, true);
    assert.equal(probe.HostConfig.Privileged, false);
    assert.equal(probe.HostConfig.NanoCpus, 200000000);
    assert.equal(probe.HostConfig.Memory, 134217728);
    assert.equal(probe.HostConfig.MemorySwap, 134217728);
    assert.equal(probe.HostConfig.PidsLimit, 32);
    assert.equal(probe.HostConfig.NetworkMode, names.network);
    assert.equal(probe.HostConfig.RestartPolicy.Name, 'no');
    assert.ok(probe.HostConfig.CapDrop.includes('ALL'));
    assert.ok(probe.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.equal(probe.HostConfig.CapAdd?.length ?? 0, 0);
    assert.equal(probe.Mounts.length, 0);
    assert.equal(Object.keys(probe.HostConfig.PortBindings ?? {}).length, 0);
    const kernel = JSON.parse(await docker(['exec', probe.Id, 'node', '-e', `const f=require('node:fs');let ro=false;
      try{f.writeFileSync('/e3-acceptance-readonly-proof','x')}catch(e){ro=e.code==='EROFS'}
      console.log(JSON.stringify({uid:process.getuid(),ro,cpu:f.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),
      memory:f.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:f.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim()}));`], { timeout: 10000 }));
    assert.equal(kernel.uid, 1000); assert.equal(kernel.ro, true);
    const [quota, period] = kernel.cpu.split(/\s+/).map(Number);
    assert.equal(quota / period, 0.2); assert.equal(kernel.memory, '134217728'); assert.equal(kernel.pids, '32');
    await waitUntil(async () => {
      const response = await metrics();
      assert.equal(response.status, 200);
      return fixedMetric(response.text, 'controller_cycle_ok') === 1 && fixedMetric(response.text, 'active') >= 1;
    }, 'Controller 真实周期与活跃指标', 15000);
    done('actual_probe_policy_and_kernel_limits');

    stage = 'controller_crash_restart';
    const beforeCrash = await controller();
    const startedAt = beforeCrash.State.StartedAt;
    // Docker's tiny init is PID 1. Kill the unique Node controller child, not
    // the namespace init (protected from same-namespace SIGKILL), and never
    // issue Docker stop/start during this automatic recovery check.
    const crash = `const fs=require('node:fs');const pids=fs.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x)).filter(x=>{
      try{const a=fs.readFileSync('/proc/'+x+'/cmdline','utf8').split('\\0').filter(Boolean);
      return Number(x)>1&&Number(x)!==process.pid&&a.length===3&&a[1]==='src/runtime/managed-entry.mjs'&&a[2]==='controller';}catch{return false}});
      if(pids.length!==1)process.exit(1);process.kill(Number(pids[0]),'SIGKILL');`;
    await docker(['exec', '--detach', beforeCrash.Id, 'node', '-e', crash], { timeout: 10000 });
    await waitUntil(async () => {
      const item = await controller();
      return item.State.Running && item.RestartCount > beforeCrash.RestartCount
        && item.State.StartedAt !== startedAt && item.State.Health?.Status === 'healthy';
    }, 'Controller restart policy 恢复', 40000);
    const afterCrash = await snapshot(first.run.runId);
    assert.equal(afterCrash.activeRunId, first.run.runId);
    assert.equal(afterCrash.run.containerRef, first.run.containerRef);
    assert.equal(afterCrash.runCount, 1, 'crash_created_extra_run');
    assertProbeIdentity(await inspect('container', first.run.containerRef), state, first.run);
    done('controller_crash_restart_preserves_run');

    stage = 'actual_ttl_recovery';
    const afterTtl = await terminal(first.run);
    assert.ok(afterTtl.recoveryAudit >= 1, 'ttl_recovery_audit_missing');
    assert.equal(afterTtl.runCount, 1);
    const ledger = await json(`SELECT json_build_object('phase',record->>'phase','terminal',record->'terminal') FROM bairui_orchestrator.runs WHERE run_id=${quote(first.run.runId)};`, names.ledger);
    assert.ok(['stopped', 'absent'].includes(ledger.phase)); assert.equal(ledger.terminal, true);
    done('actual_ttl_delete_controller_recovery_and_audit');

    stage = 'governance_stop';
    const second = await start(afterTtl.generation);
    assert.notEqual(second.run.runId, first.run.runId);
    assert.notEqual(second.run.containerRef, first.run.containerRef);
    assertProbeIdentity(await inspect('container', second.run.containerRef), state, second.run);
    await governance('suspended');
    const afterGovernance = await terminal(second.run);
    assert.ok(afterGovernance.governanceStopAudit >= 1, 'governance_stop_audit_missing');
    await governance('active');
    // Two full observation cycles plus a second read establish that release never
    // issued a replacement start. Historical test records intentionally remain.
    await delay(12000);
    const released = await snapshot(second.run.runId);
    assert.equal(released.activeRunId, null); assert.equal(released.desiredState, 'stopped');
    assert.equal(released.runCount, 2); assert.equal(released.routeCount, 0);
    assert.equal(released.generation, afterGovernance.generation);
    done('real_governance_stop_release_does_not_restart');

    stage = 'real_alert_firing';
    await waitUntil(async () => {
      const response = await metrics();
      assert.equal(response.status, 200);
      return fixedMetric(response.text, 'controller_cycle_ok') === 1 && fixedMetric(response.text, 'active') === 0;
    }, '告警前 Controller 健康快照', 20000);
    const expectedScrapes = preprod.monitoring.runtime.environments.length;
    await waitUntil(async () => {
      const up = await prometheusAggregate('sum(up{job="bairui-runtime-controller"})');
      const unavailable = await prometheusAggregate('count(ALERTS{alertname="RuntimeControllerUnavailable",alertstate="firing"}) or vector(0)');
      return up === expectedScrapes && unavailable === 0;
    }, '真实 Controller 全部采集与告警基线', 90000);
    done('controller_scrapes_and_alert_baseline');
    const outage = Date.now();
    const paused = await controller();
    await docker(['stop', '--time', '30', paused.Id]);
    controllerPaused = true;
    await apiHealthy();
    await waitUntil(async () => {
      await apiHealthy();
      const up = await prometheusAggregate('sum(up{job="bairui-runtime-controller"})');
      return up === expectedScrapes - 1 && receivedRuntimeAlert(await alertRecords(preprod, 1000), 'firing', outage);
    }, '真实 RuntimeControllerUnavailable firing', 180000);
    done('actual_preprod_controller_outage_alert_and_api_health');

    stage = 'real_alert_resolved';
    const recovery = Date.now();
    await docker(['start', (await controller()).Id]);
    await waitUntil(async () => (await controller()).State.Health?.Status === 'healthy', '预发 Controller 恢复', 90000);
    controllerPaused = false;
    await waitUntil(async () => await prometheusAggregate('sum(up{job="bairui-runtime-controller"})') === expectedScrapes
      && receivedRuntimeAlert(await alertRecords(preprod, 1000), 'resolved', recovery), '真实 RuntimeControllerUnavailable resolved', 180000);
    await apiHealthy();
    done('actual_preprod_controller_alert_resolved');
  } catch (error) {
    failure = error;
    report.failedStage = stage;
  } finally {
    const cleanup = async action => {
      try { await action(); }
      catch (error) { cleanupFailure ??= error; report.cleanupFailed = true; }
    };
    await cleanup(async () => {
      const currentController = await controller();
      if (controllerPaused || !currentController.State.Running) {
        await docker(['start', currentController.Id]);
        await waitUntil(async () => (await controller()).State.Health?.Status === 'healthy', '验收 Controller 恢复', 90000);
      }
    });
    if (seeded) {
      await cleanup(async () => {
        // Recovery always uses the current generation and the actual control
        // function. A timeout is failure and is never interpreted as absence.
        const current = await snapshot();
        if (current.activeRunId) {
          const result = await json(`SELECT runtime_control_request_stop(${quote(ids.user)},${quote(ids.agent)},'${randomUUID()}',${current.generation},'E3验收失败清理');`);
          assert.ok(['accepted', 'noop'].includes(result.result), 'cleanup_stop_not_accepted');
          if (current.run?.containerRef) await terminal(current.run);
          else await waitUntil(async () => {
              const final = await snapshot(current.activeRunId);
              return final.activeRunId === null && final.run?.status === 'stopped' && final.run.stopConfirmed && final.routeCount === 0;
            }, '验收剩余 run 受控停止', 180000);
        }
      });
      // Attempt the independent test identity cleanups even when run cleanup
      // fails; an infrastructure outage must not retain a live test admin role.
      await cleanup(async () => {
        const account = await json(`SELECT platform_account_access(${quote(ids.user)});`);
        if (account.status !== 'active') await governance('active');
      });
      await cleanup(async () => {
        await sql(`UPDATE platform_role_bindings SET revoked_at=clock_timestamp() WHERE user_id=${quote(ids.admin)} AND revoked_at IS NULL;`);
        assert.equal(await sql(`SELECT count(*) FROM platform_role_bindings WHERE user_id=${quote(ids.admin)} AND revoked_at IS NULL;`), '0');
      });
      await cleanup(async () => {
        const final = await snapshot();
        assert.equal(final.activeRunId, null); assert.equal(final.routeCount, 0);
      });
      if (!cleanupFailure) done('test_records_retained_test_admin_revoked_and_no_active_run');
    }
    report.finishedAt = new Date().toISOString();
    report.success = !failure && !cleanupFailure;
    const directory = join(root, 'output', 'runtime');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'acceptance-' + report.finishedAt.replace(/[:.]/g, '-') + '.json');
    await writeFile(path, JSON.stringify(report, null, 2) + '\n');
    console.log('E3 常驻预发验收报告：' + path);
  }
  if (cleanupFailure) throw new Error('runtime_deployment_acceptance_cleanup_failed');
  if (failure) throw new Error('runtime_deployment_acceptance_failed_' + stage);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-test')) testAcceptanceHelpers();
  else {
    // Do not introduce top-level-await cycles with the preprod/monitoring CLI.
    import('./cli-keepalive.mjs').then(({ runWithKeepAlive }) => runWithKeepAlive(async () => {
      const { withLock } = await import('./preprod.mjs');
      return withLock(testRuntimeDeployment);
    })).catch(error => {
      console.error('E3 常驻预发验收失败：' + error.message); process.exitCode = 1;
    });
  }
}
