import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { up, stop, withLock, assertSchemaCurrent } from './preprod.mjs';
import { validateApiReplicas, consolePublicOrigin } from './preprod-config.mjs';
import { runWithKeepAlive } from './cli-keepalive.mjs';
import { deploymentContext, deploymentStatus, deploymentLogs, consolidateBusinessMonitoring, logComponents } from './deployment-resources.mjs';
import { coldDeploymentBackup, preflightDeploymentBackup } from './deployment-backup.mjs';

const commands = ['check', 'up', 'update', 'status', 'logs', 'backup', 'stop', 'consolidate'];
export const usage = `用法：npm run deploy -- <命令>
  check | status                       只读检查 / 查看整套服务
  up [--replicas 1|2]                   启动，默认一副本，保留已保存的显式目标
  update [--replicas 1|2]               校验迁移基线，停服冷备，再部署当前工作区源码
  logs [组件] [--tail 1..1000]          有界日志；默认 api / 100 行
  stop                                 停止本安装，保留卷与 Secret
  backup                               已停止安装的冷备份，不自动启动任何服务
  consolidate business-monitoring      显式停用独立业务监控，保留数据
  --help                               无需 Docker 即可查看帮助
组件：${logComponents.join(', ')}
本入口只管理现有常驻预发，不读取业务 .env，不合并数据库，不自动拉取 Git 或迁移。`;

export function parseDeploymentArguments(args) {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) return { command: 'help' };
  const [command, ...rest] = args;
  assert.ok(commands.includes(command), 'deployment_arguments_invalid');
  const result = { command };
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i];
    if (value === '--replicas' && ['up', 'update'].includes(command) && result.replicas === undefined) {
      const text = rest[++i];
      assert.ok(['1', '2'].includes(text), 'deployment_arguments_invalid');
      result.replicas = Number(text);
    } else if (value === '--tail' && command === 'logs' && result.tail === undefined) {
      const text = rest[++i];
      assert.ok(/^[1-9][0-9]{0,3}$/.test(text ?? '') && Number(text) <= 1000, 'deployment_arguments_invalid');
      result.tail = Number(text);
    } else if (command === 'logs' && logComponents.includes(value) && result.component === undefined) result.component = value;
    else if (command === 'consolidate' && value === 'business-monitoring' && !result.target) result.target = value;
    else throw new Error('deployment_arguments_invalid');
  }
  assert.ok(command !== 'consolidate' || result.target === 'business-monitoring', 'deployment_arguments_invalid');
  return result;
}

const defaults = { context: deploymentContext, compatible: async (state, context) => {
  await assertSchemaCurrent(state);
  consolePublicOrigin(process.env.BAIRUI_CONSOLE_PUBLIC_ORIGIN ?? state.publicOrigin);
  await preflightDeploymentBackup(context, {}, { stopped: false });
}, up, stop, backup: coldDeploymentBackup,
  status: deploymentStatus, logs: deploymentLogs, consolidate: consolidateBusinessMonitoring, report: console.log };

export async function runDeployment(options, overrides = {}) {
  const deps = { ...defaults, ...overrides }, { command } = options;
  assert.ok([...commands, 'help'].includes(command), 'deployment_arguments_invalid');
  if (command === 'help') { deps.report(usage); return; }
  if (options.replicas !== undefined) validateApiReplicas(options.replicas);
  const context = await deps.context();
  if (['up', 'update', 'check'].includes(command)) assert.ok(!context.backupHelpers?.length, 'deployment_backup_helper_pending: 先核对并清理遗留备份辅助容器。');
  if (['backup', 'update', 'stop', 'logs', 'consolidate'].includes(command)) assert.ok(context.state, 'deployment_not_installed');
  if (command === 'check') {
    if (context.state) await deps.compatible(context.state, context);
    deps.report(context.state ? '节点、安装归属和已登记持久卷检查通过；未启动服务。' : 'Docker 单节点检查通过；尚未安装。');
  } else if (command === 'status') await deps.status(context);
  else if (command === 'logs') await deps.logs(context, { component: options.component ?? 'api', tail: options.tail ?? 100 });
  else if (command === 'stop') await deps.stop();
  else if (command === 'backup') return deps.backup(context);
  else if (command === 'consolidate') {
    assert.equal(options.target, 'business-monitoring', 'deployment_arguments_invalid');
    await deps.consolidate(context);
  } else {
    const apiReplicas = validateApiReplicas(options.replicas ?? context.state?.apiReplicas ?? 1);
    if (command === 'update') {
      await deps.compatible(context.state, context);
      await deps.stop();
      const backup = await deps.backup(await deps.context());
      deps.report('冷备份已完成：' + backup + '；开始部署当前源码。');
    }
    await deps.up({ apiReplicas });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try { options = parseDeploymentArguments(process.argv.slice(2)); }
  catch { console.error(usage); process.exitCode = 1; }
  if (options) runWithKeepAlive(() => ['help', 'check', 'status', 'logs'].includes(options.command)
    ? runDeployment(options) : withLock(() => runDeployment(options)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
