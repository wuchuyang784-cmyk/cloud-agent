import assert from 'node:assert/strict';
export const runtimeLabel = 'bairui.runtime.installation';
export function runtimeNames(environment) {
  assert.ok(['business', 'preprod'].includes(environment), 'runtime_environment_invalid');
  const prefix = 'bairui-runtime-' + environment;
  return { controller: prefix + '-controller', orchestrator: prefix + '-orchestrator',
    control: prefix + '-control', network: prefix + '-runs', metricsSecret: prefix + '-metrics',
    database: environment === 'business' ? 'bairui' : 'bairui_preprod', ledger: 'bairui_runtime_ledger_' + environment,
    host: environment === 'business' ? 'bairui-postgres' : 'bairui-preprod_db' };
}
export function controllerGrants() {
  return `GRANT USAGE ON SCHEMA public TO bairui_runtime_controller;
GRANT EXECUTE ON FUNCTION runtime_control_claim(text,integer),runtime_control_prepare(text,uuid,integer),
runtime_control_complete(text,uuid,text,text,integer),runtime_control_commit_started(text,uuid,text,text,bigint,text,text,integer),
runtime_control_commit_stopped(text,uuid,text,text,bigint,bigint,text,timestamptz,integer),
runtime_control_reconcile_governance(text,integer),runtime_supervision_claim(text),
runtime_supervision_record(text,uuid,text,text,bigint,bigint,text,timestamptz,text,text),runtime_supervision_snapshot()
TO bairui_runtime_controller;`;
}
export function runtimeContainerArguments(kind, input) {
  assert.ok(['controller', 'orchestrator'].includes(kind), 'runtime_kind_invalid');
  const n = runtimeNames(input.environment);
  assert.match(input.installation, /^[a-f0-9]{24}$/);
  assert.match(input.apiImage, /^bairui\/platform-api-preprod:[a-f0-9]{16}$/);
  assert.match(input.orchestratorImage, /^bairui\/runtime-orchestrator:[a-f0-9]{16}$/);
  assert.ok(typeof input.directory === 'string' && !/[\r\n,]/.test(input.directory));
  const controller = kind === 'controller';
  const check = controller
    ? "const fs=require('node:fs'),c=JSON.parse(fs.readFileSync('/config/controller.json'));fetch('http://127.0.0.1:9495/metrics',{headers:{Authorization:'Bearer '+fs.readFileSync(c.BAIRUI_RUNTIME_CONTROLLER_METRICS_TOKEN_FILE,'utf8').trim()},signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    : "require('node:https').get('https://127.0.0.1:9494/',{ca:require('node:fs').readFileSync('/config/tls/cert.pem')},r=>{r.resume();process.exit(r.statusCode===401?0:1)}).on('error',()=>process.exit(1))";
  return ['run', '-d', '--pull=never', '--name', n[kind], '--label', runtimeLabel + '=' + input.installation,
    '--restart=unless-stopped', '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    controller ? '--user=1000:1000' : '--user=0:0', '--cpus=0.50', '--memory=256m', '--pids-limit=64',
    '--network', n.control, '--log-driver=json-file', '--log-opt=max-size=5m', '--log-opt=max-file=3',
    '--mount', 'type=bind,source=' + input.directory + '/' + kind + ',target=/config,readonly',
    ...(controller ? [] : ['--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock']),
    '--env', 'NODE_ENV=production', '--env', 'NODE_EXTRA_CA_CERTS=/config/tls/cert.pem',
    '--env', 'BAIRUI_RUNTIME_CONFIG_FILE=/config/' + kind + '.json',
    '--health-cmd', 'node -e ' + JSON.stringify(check), '--health-interval=10s', '--health-timeout=4s', '--health-retries=3',
    controller ? input.apiImage : input.orchestratorImage, 'node', 'src/runtime/managed-entry.mjs', kind];
}
