import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root, docker, inspect, localDocker } from './preprod.mjs';
import { names } from './preprod-config.mjs';
import { backupVolumeArguments, backupArchiveCommands, runBackupHelper } from './deployment-backup.mjs';
import { monitoringAssets, monitorImages } from './monitoring-config.mjs';
import { ruleTests } from './monitoring-rules.test.mjs';

// Explicit isolated acceptance: uses existing local images only. Never reads .env
// or installation state; never starts, stops or mounts an existing installation.
assert.equal(process.env.BAIRUI_DEPLOYMENT_LIVE_TEST, '1', '显式设置 BAIRUI_DEPLOYMENT_LIVE_TEST=1；仅创建并清理随机测试资源。');
await localDocker();
const suffix = randomBytes(12).toString('hex'), ownerLabel = 'bairui.deployment.acceptance';
const volume = 'bairui-deployment-test-' + suffix;
const directory = join(root, 'output', 'deployment', 'acceptance', new Date().toISOString().replace(/[:.]/g, '-') + '-' + suffix);
await mkdir(directory, { recursive: true });
const report = { success: false, checks: [], errors: [], scope: 'isolated archive helper and Prometheus rules; not a full deployment' };
const before = await docker(['ps', '-aq', '--no-trunc']);
const priorVolumes = (await docker(['volume', 'ls', '-q'])).split('\n').sort();
const passed = text => { report.checks.push(text); console.log('PASS: ' + text); };
try {
  const image = 'bairui/platform-api-preprod:984167c866f5c602';
  await inspect('image', image).then(value => assert.ok(value, 'existing_fixture_image_required'));
  await inspect('image', monitorImages.prometheus).then(value => assert.ok(value, 'existing_prometheus_image_required'));
  assert.equal(await inspect('volume', volume), null);
  await docker(['volume', 'create', '--label', ownerLabel + '=' + suffix, volume]);
  const shared = ['run', '--rm', '--pull=never', '--network=none', '--label', ownerLabel + '=' + suffix];
  const payload = randomBytes(128).toString('hex');
  await docker([...shared, '--mount', 'type=volume,source=' + volume + ',target=/data', image, 'node', '-e',
    "const f=require('node:fs');f.mkdirSync('/data/private',{mode:0o700});f.writeFileSync('/data/private/fixture',process.argv[1],{mode:0o600});f.chownSync('/data/private/fixture',999,999);f.chownSync('/data/private',999,999);", '--', payload]);
  const state = { installation: suffix, revision: '984167c866f5c602' };
  const args = backupVolumeArguments({ volume: names.volume, directory, state })
    .map(a => a === 'type=volume,source=' + names.volume + ',target=/source,readonly' ? 'type=volume,source=' + volume + ',target=/source,readonly' : a);
  const archive = backupArchiveCommands('fixture.tar.gz');
  await runBackupHelper(args, archive.archive, state, { command: docker, inspect });
  await runBackupHelper(args.map(a => a.endsWith(',target=/backup') ? a + ',readonly' : a), archive.verify, state, { command: docker, inspect });
  const verify = "const c=require('node:child_process');const text=c.execFileSync('tar',['-xOzf','/backup/fixture.tar.gz','./private/fixture'],{encoding:'utf8'});if(text!==process.argv[1])process.exit(1);";
  await docker([...args.map(a => a.endsWith(',target=/backup') ? a + ',readonly' : a), 'node', '-e', verify, '--', payload]);
  report.archiveSha256 = createHash('sha256').update(await readFile(join(directory, 'fixture.tar.gz'))).digest('hex');
  passed('actual API-image tar archives restrictive UID 999 / 0700 / 0600 data through read-only source mount and restores identical bytes');
  let interruptedName;
  await assert.rejects(runBackupHelper(args, ['node', '-e', 'setInterval(()=>{},1000)'], state, {
    inspect,
    command: async (command, options) => {
      if (command[0] === 'run') {
        interruptedName = command[command.indexOf('--name') + 1];
        await docker([command[0], '-d', ...command.slice(1)], options);
        throw new Error('injected_client_result_lost');
      }
      return docker(command, options);
    },
  }), /injected_client_result_lost/);
  assert.equal(await inspect('container', interruptedName), null);
  passed('actual still-running helper is removed by verified full ID when its Docker client result is lost');
  await writeFile(join(directory, 'rules.json'), JSON.stringify(monitoringAssets()['rules.json']));
  await writeFile(join(directory, 'rule-tests.json'), JSON.stringify(ruleTests()));
  const result = await docker([...shared, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--mount', 'type=bind,source=' + directory.replaceAll('\\', '/') + ',target=/etc/bairui,readonly',
    '--entrypoint', '/bin/promtool', monitorImages.prometheus, 'test', 'rules', '/etc/bairui/rule-tests.json']);
  assert.match(result, /SUCCESS/);
  passed('official promtool passes single-replica, explicit two-replica, legacy fallback, zero-discovery and existing alert scenarios');
  assert.deepEqual(await readdir(directory).then(items => items.sort()), ['fixture.tar.gz', 'rule-tests.json', 'rules.json']);
  report.success = true;
} catch (error) {
  report.errors.push(error.message); process.exitCode = 1;
} finally {
  const item = await inspect('volume', volume);
  if (item) { assert.equal(item.Labels?.[ownerLabel], suffix); await docker(['volume', 'rm', volume]); }
  const after = await docker(['ps', '-aq', '--no-trunc']);
  const volumes = (await docker(['volume', 'ls', '-q'])).split('\n').sort();
  if (before !== after || JSON.stringify(priorVolumes) !== JSON.stringify(volumes)) {
    report.success = false; report.errors.push('existing Docker container/volume inventory changed'); process.exitCode = 1;
  } else passed('temporary volume and helper containers removed; existing container IDs and all persistent volumes unchanged');
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log('Report: ' + join(directory, 'report.json'));
  if (!report.success) console.error(report.errors.join('\n'));
}
