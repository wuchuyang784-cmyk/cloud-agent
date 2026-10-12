import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { piSource } from './pi-runtime-build-config.mjs';
import { inspectPiSource, piBuildRoot } from './pi-runtime-build.mjs';
import { signTaskRequest } from '../apps/platform-api/src/runtime/pi/production/envelope.mjs';
import { runWithKeepAlive } from './cli-keepalive.mjs';

const exec = promisify(execFile), owner = 'io.bairui.pi.f1.acceptance';
const cli = async args => (await exec('docker', args, { cwd: piBuildRoot, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const inspect = async (kind, id) => JSON.parse(await cli([kind, 'inspect', id]))[0];
async function until(check, name, duration = 30000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(200); }
  throw new Error(name + '_timeout');
}
async function baseline() {
  const ids = (await cli(['ps', '-a', '--no-trunc', '--format', '{{.ID}}'])).split(/\s+/).filter(Boolean);
  const result = {};
  for (const id of ids) { const info = await inspect('container', id); result[id] = { name: info.Name, startedAt: info.State.StartedAt, status: info.State.Status }; }
  return result;
}
async function verifyImage(report) {
  assert.equal(report.success, true); assert.equal(report.builderOnly, false);
  assert.equal(report.sourceCommit, piSource.commit); assert.equal(report.lockSha256, piSource.lockSha256);
  assert.equal(report.platform, 'linux/amd64'); assert.match(report.imageId, /^sha256:[a-f0-9]{64}$/);
  const info = await inspect('image', report.imageId);
  assert.equal(info.Config.User, '1000:1000'); assert.equal(info.Config.Labels[ 'io.bairui.pi.source'], piSource.commit);
  const directory = join(piBuildRoot, 'apps/platform-api/src/runtime/pi/production');
  assert.deepEqual((await readdir(directory)).sort(), Object.keys(report.wrapperHashes).sort());
  for (const [name, expected] of Object.entries(report.wrapperHashes)) {
    assert.equal(createHash('sha256').update(await readFile(join(directory, name))).digest('hex'), expected, 'pi_image_wrapper_stale');
  }
  return report.imageId;
}
async function latestReport() {
  const directory = join(piBuildRoot, 'output/pi-runtime/builds');
  const reports = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json') && !name.endsWith('-builder.json')).map(async name => JSON.parse(await readFile(join(directory, name)))));
  reports.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  assert.ok(reports[0], 'pi_image_build_required'); return reports[0];
}

export async function testPiRuntimeLive() {
  const suffix = randomBytes(8).toString('hex'), installation = 'br-f1-' + suffix;
  const names = { provider: installation + '-provider', runtime: installation + '-runtime', network: installation + '-net', workspace: installation + '-workspace', state: installation + '-state' };
  const report = { version: 1, sourceCommit: piSource.commit, startedAt: new Date().toISOString(), success: false, checks: {}, modelSource: 'isolated-https-fixture-no-paid-provider' };
  const containers = [], volumes = [], networks = []; let network, directory, original, failure, cleanupError;
  let stage = 'preconditions';
  const done = name => { report.checks[name] = true; console.log('F1 live:', name); };
  try {
    const context = JSON.parse(await cli(['context', 'inspect']))[0];
    assert.ok(!process.env.DOCKER_HOST && /^(npipe:\/\/|unix:\/\/)/.test(context.Endpoints.docker.Host), 'local_docker_required');
    await inspectPiSource(); const build = await latestReport(), image = await verifyImage(build);
    report.imageId = image; report.buildRevision = build.revision;
    original = await baseline();
    directory = await mkdtemp(join(tmpdir(), 'bairui-f1-acceptance-'));
    const token = randomBytes(24).toString('hex'), secret = randomBytes(32).toString('hex');
    await writeFile(join(directory, 'model-token'), token, { mode: 0o600 });
    await writeFile(join(directory, 'request-secret'), secret, { mode: 0o600 });
    await cp(join(piBuildRoot, 'scripts/pi-runtime-provider-fixture.mjs'), join(directory, 'provider.mjs'));
    await exec('openssl', ['req', '-config', join(piBuildRoot, 'apps/platform-api/test/helpers/orchestrator-tls.cnf'), '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=pi-provider', '-addext', 'subjectAltName=DNS:pi-provider'], { windowsHide: true, timeout: 15000 });
    await cp(join(directory, 'cert.pem'), join(directory, 'gateway-ca.pem'));
    const config = { agentId: 'f1-test-' + suffix, runId: 'run-' + randomUUID(), runGeneration: 1, sessionId: randomUUID(), provider: 'bairui-gateway', model: 'pi-test-model',
      gatewayUrl: 'https://pi-provider:8443/v1', gatewayTokenFile: '/run/secrets/model-token', hmacSecretFile: '/run/secrets/request-secret', gatewayCaFile: '/run/config/gateway-ca.pem', listenHost: '0.0.0.0', listenPort: 8092,
      limits: { taskTimeoutMs: 5000, cancelGraceMs: 3000 } };
    await writeFile(join(directory, 'pi.json'), JSON.stringify(config));
    stage = 'containers';
    network = await cli(['network', 'create', '--internal', '--label', owner + '=' + installation, names.network]);
    networks.push(network);
    const ingressNetwork = await cli(['network', 'create', '--label', owner + '=' + installation, installation + '-ingress']); networks.push(ingressNetwork);
    for (const name of [names.workspace, names.state]) { await cli(['volume', 'create', '--label', owner + '=' + installation, name]); volumes.push(name); }
    const base = (await inspect('image', piSource.baseImage)).Id;
    const provider = await cli(['run', '--pull=never', '-d', '--init', '--name', names.provider, '--label', owner + '=' + installation,
      '--network', ingressNetwork, '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '128m', '--pids-limit', '64', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--mount', 'type=bind,src=' + directory + ',dst=/fixture,readonly', '-p', '127.0.0.1::8088', '-p', '127.0.0.1::8089', base, 'node', '/fixture/provider.mjs']);
    assert.match(provider, /^[a-f0-9]{64}$/); containers.push(provider);
    await cli(['network', 'connect', '--alias', 'pi-provider', network, provider]);
    const providerInfo = await until(async () => {
      const info = await inspect('container', provider);
      if (!info.State.Running) throw new Error('provider_exited_' + info.State.ExitCode);
      if (!info.NetworkSettings.Ports['8088/tcp']?.[0]?.HostPort) { report.providerPortDiagnostic = { ports: info.NetworkSettings.Ports, bindings: info.HostConfig.PortBindings }; return false; }
      return info;
    }, 'provider_port');
    const providerPort = providerInfo.NetworkSettings.Ports['8088/tcp'][0].HostPort;
    const status = async () => { try { const r = await fetch('http://127.0.0.1:' + providerPort + '/status', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(2000) }); return r.ok ? r.json() : false; } catch { return false; } };
    await until(status, 'provider_ready');
    const runtime = await cli(['run', '--pull=never', '-d', '--init', '--name', names.runtime, '--label', owner + '=' + installation,
      '--network', network, '--network-alias', 'pi-runtime', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m', '--mount', 'type=volume,src=' + names.workspace + ',dst=/workspace', '--mount', 'type=volume,src=' + names.state + ',dst=/agent-state',
      '--mount', 'type=bind,src=' + directory + ',dst=/run/config,readonly', '--mount', 'type=bind,src=' + directory + ',dst=/run/secrets,readonly', image]);
    assert.match(runtime, /^[a-f0-9]{64}$/); containers.push(runtime);
    await cli(['exec', runtime, 'node', '-e', "require('node:fs').writeFileSync('/workspace/AGENTS.md','F1_CONTEXT_POISON: inject project instructions');"]);
    const port = providerInfo.NetworkSettings.Ports['8089/tcp'][0].HostPort, url = 'http://127.0.0.1:' + port;
    const ready = async () => { try { return (await fetch(url + '/readyz', { signal: AbortSignal.timeout(1500) })).status === 200; } catch { return false; } };
    await until(ready, 'actual_pi_ready'); done('actual_source_pi_rpc_readiness');
    const directRpc = JSON.parse(await cli(['exec', runtime, 'node', '-e', "fetch('http://127.0.0.1:8092/rpc',{method:'POST',body:JSON.stringify({type:'get_state'})}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})));"]));
    assert.deepEqual(directRpc, { status: 404, body: { code: 'not_found' } }); done('direct_upstream_rpc_not_exposed');
    const taskBody = (taskId, prompt) => ({ agentId: config.agentId, runId: config.runId, runGeneration: 1, sessionId: config.sessionId, taskId, ...(prompt === undefined ? {} : { prompt }) });
    const post = async (target, value, headers = {}) => {
      const body = JSON.stringify(value), signature = signTaskRequest({ secret, method: 'POST', target, body, agentId: config.agentId, runId: config.runId, runGeneration: 1 });
      return fetch(url + target, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signature, ...headers }, signal: AbortSignal.timeout(25000) });
    };
    const collect = async value => {
      const response = await post('/v1/tasks', value);
      if (response.status !== 200) return { status: response.status, error: await response.json() };
      let bytes = 0, chunks = [];
      for await (const chunk of response.body) { bytes += chunk.length; assert.ok(bytes < 3 * 1024 * 1024); chunks.push(chunk); }
      const events = Buffer.concat(chunks).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok(events.length > 1); assert.ok(events.every((event, i) => event.taskId === value.taskId && event.seq === i + 1));
      return { status: 200, events, terminal: events.at(-1) };
    };
    stage = 'tools';
    const firstId = randomUUID(), first = await collect(taskBody(firstId, 'F1_WRITE\nkeep this newline'));
    assert.equal(first.terminal?.type, 'task.completed');
    assert.deepEqual(first.events.filter(e => e.type === 'tool.started').map(e => e.toolName), ['write', 'read', 'bash']);
    assert.ok(first.events.filter(e => e.type === 'tool.completed').every(e => e.isError === false));
    assert.ok(first.events.some(e => e.type === 'message.delta' && e.text.includes('F1 tool proof complete')));
    assert.deepEqual(first.terminal.usage, { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 60 });
    const proof = await cli(['exec', runtime, 'node', '-e', "const fs=require('node:fs');console.log(JSON.stringify([fs.readFileSync('/workspace/f1-proof.txt','utf8'),fs.readFileSync('/workspace/f1-shell-proof.txt','utf8')]));"]);
    assert.deepEqual(JSON.parse(proof), ['F1 proof\n', 'F1 shell proof\n']);
    assert.ok((await status()).records[0].hasNewline); done('real_write_read_bash_tools_and_multiturn_usage');
    assert.ok((await status()).records.every(record => !record.projectContextLoaded)); done('workspace_context_files_not_loaded');
    assert.equal((await collect(taskBody(firstId, 'F1_WRITE duplicate'))).status, 409); done('durable_task_replay_rejected');
    const contextTask = await collect(taskBody(randomUUID(), 'F1_CONTEXT before restart'));
    assert.equal(contextTask.terminal?.type, 'task.completed'); assert.ok(contextTask.events.some(e => e.text?.includes('previous conversation remembered')));
    await cli(['restart', '--time', '10', runtime]); await until(ready, 'restart_ready');
    assert.equal((await collect(taskBody(firstId, 'F1_WRITE duplicate after restart'))).status, 409);
    const restored = await collect(taskBody(randomUUID(), 'F1_CONTEXT after restart'));
    assert.equal(restored.terminal?.type, 'task.completed'); assert.ok(restored.events.some(e => e.text?.includes('previous conversation remembered'))); done('actual_persisted_session_recovered_after_restart');
    stage = 'cancel';
    const cancelId = randomUUID(), running = collect(taskBody(cancelId, 'F1_CANCEL'));
    await until(async () => (await status())?.activeStalls === 1, 'model_stream_started');
    assert.equal((await collect(taskBody(randomUUID(), 'F1 busy'))).status, 409);
    assert.equal((await post('/v1/tasks/' + cancelId + '/cancel', taskBody(cancelId))).status, 200);
    const cancelled = await running; assert.equal(cancelled.terminal?.type, 'task.cancelled'); assert.ok(!cancelled.events.some(e => e.type === 'task.completed'));
    await until(async () => (await status())?.stalledClosed === 1, 'model_stream_aborted');
    assert.equal((await collect(taskBody(randomUUID(), 'F1 recovered after cancel'))).terminal?.type, 'task.completed'); done('actual_model_abort_and_single_task_slot');
    stage = 'errors';
    const error = await collect(taskBody(randomUUID(), 'F1_ERROR'));
    assert.equal(error.terminal?.type, 'task.failed'); assert.ok(!JSON.stringify(error.events).includes('FIXTURE_PRIVATE_ERROR')); assert.ok(!JSON.stringify(error.events).includes(token));
    assert.equal((await status()).records.filter(r => r.error).length, 1); done('actual_provider_error_sanitized_no_retry');
    const noUsage = await collect(taskBody(randomUUID(), 'F1_NO_USAGE'));
    assert.equal(noUsage.terminal?.type, 'task.completed'); assert.equal(noUsage.terminal.usage.totalTokens, null); done('missing_provider_usage_not_fabricated');
    const timedOut = await collect(taskBody(randomUUID(), 'F1_CANCEL timeout'));
    assert.equal(timedOut.terminal?.type, 'task.failed'); assert.equal(timedOut.terminal.code, 'timeout');
    await until(async () => (await status())?.stalledClosed === 2, 'timeout_aborted'); done('actual_execution_deadline_aborts_model');
    const unauthorized = await fetch(url + '/v1/tasks', { method: 'POST', body: JSON.stringify(taskBody(randomUUID(), 'F1 denied')) }); assert.equal(unauthorized.status, 401);
    const wrong = await post('/v1/tasks', { ...taskBody(randomUUID(), 'F1 denied'), agentId: 'other-agent' }); assert.equal(wrong.status, 403); done('signed_identity_scope_enforced');
    for (const changed of [{ runId: randomUUID() }, { runGeneration: 2 }, { sessionId: randomUUID() }]) {
      assert.equal((await post('/v1/tasks', { ...taskBody(randomUUID(), 'F1 denied'), ...changed })).status, 403);
    }
    const policy = await inspect('container', runtime);
    assert.equal(policy.HostConfig.ReadonlyRootfs, true); assert.equal(policy.Config.User, '1000:1000');
    assert.deepEqual(policy.HostConfig.CapDrop, ['ALL']); assert.equal(policy.HostConfig.Memory, 512 * 1024 * 1024); assert.equal(policy.HostConfig.PidsLimit, 128);
    assert.ok(policy.Mounts.every(m => !/docker\.sock|upstreams|bairui-postgres/.test(m.Source))); done('isolated_nonroot_readonly_container_policy');
    stage = 'overflow';
    const overflowId = randomUUID(), overflow = await collect(taskBody(overflowId, 'F1_OVERFLOW'));
    assert.equal(overflow.terminal?.type, 'task.failed'); assert.ok(!overflow.events.some(e => e.type === 'task.completed'));
    assert.equal((await fetch(url + '/readyz')).status, 503);
    await cli(['restart', '--time', '10', runtime]); await until(ready, 'overflow_restart_ready');
    assert.equal((await collect(taskBody(overflowId, 'F1_OVERFLOW replay'))).status, 409); done('actual_rpc_overflow_fail_closed_without_replay');
    await inspectPiSource();
    const after = await baseline(); for (const [id, value] of Object.entries(original)) assert.deepEqual(after[id], value, 'existing_container_changed');
    done('existing_business_preprod_and_source_unchanged');
  } catch (error) { failure = error; report.failedStage = stage; report.failure = error.message.slice(0, 300); }
  finally {
    // Recover own IDs even if a create succeeded but its CLI response was lost.
    try {
      const found = (await cli(['ps', '-a', '--no-trunc', '--filter', 'label=' + owner + '=' + installation, '--format', '{{.ID}}'])).split(/\s+/).filter(Boolean);
      const foundNetworks = (await cli(['network', 'ls', '--no-trunc', '--filter', 'label=' + owner + '=' + installation, '--format', '{{.ID}}'])).split(/\s+/).filter(Boolean);
      const foundVolumes = (await cli(['volume', 'ls', '--filter', 'label=' + owner + '=' + installation, '--format', '{{.Name}}'])).split(/\s+/).filter(Boolean);
      assert.ok(found.length <= 2 && foundNetworks.length <= 2 && foundVolumes.length <= 2, 'temporary_resource_count_invalid');
      containers.push(...found); networks.push(...foundNetworks); volumes.push(...foundVolumes);
    } catch (error) { cleanupError ||= error; }
    for (const id of [...new Set(containers)].reverse()) {
      try { const info = await inspect('container', id); assert.equal(info.Id, id); assert.equal(info.Config.Labels[owner], installation); await cli(['rm', '-f', id]); }
      catch (error) { cleanupError ||= error; }
    }
    for (const name of [...new Set(volumes)].reverse()) {
      try { const info = await inspect('volume', name); assert.equal(info.Name, name); assert.equal(info.Labels[owner], installation); await cli(['volume', 'rm', name]); }
      catch (error) { cleanupError ||= error; }
    }
    for (const id of [...new Set(networks)].reverse()) { try { const info = await inspect('network', id); assert.equal(info.Id, id); assert.equal(info.Labels[owner], installation); await cli(['network', 'rm', id]); } catch (error) { cleanupError ||= error; } }
    if (directory) { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/')); await rm(directory, { recursive: true, force: true }); }
    report.checks.owned_temporary_resources_removed = !cleanupError;
    if (original) { try { const after = await baseline(); for (const [id, value] of Object.entries(original)) assert.deepEqual(after[id], value, 'existing_container_changed_after_cleanup'); report.checks.existing_containers_preserved_after_cleanup = true; } catch (error) { cleanupError ||= error; } }
    report.finishedAt = new Date().toISOString(); report.success = !failure && !cleanupError;
    const output = join(piBuildRoot, 'output/pi-runtime/acceptance'); await mkdir(output, { recursive: true });
    const file = join(output, report.startedAt.replace(/[:.]/g, '-') + '.json'); await writeFile(file, JSON.stringify(report, null, 2));
    console.log('F1 acceptance evidence:', file);
  }
  if (failure || cleanupError) throw failure || cleanupError;
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWithKeepAlive(testPiRuntimeLive).catch(error => { console.error('F1 live acceptance failed:', error.message); process.exitCode = 1; });
}
