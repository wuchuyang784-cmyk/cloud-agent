import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('keeps the original MVP agent workspace navigation', () => {
  for (const label of [
    '总览',
    '资源库',
    '智能体 Agents',
    '会话管理',
    '快速开始',
    '我的项目',
    '运行记录',
    '接入配置',
    '客服助手',
    '数据分析 Copilot',
  ]) {
    assert.ok(source.includes(label), `missing client workspace entry: ${label}`);
  }

  for (const label of ['平台管理', '组织成员', 'License 授权', '服务器', '审计日志']) {
    assert.ok(!source.includes(label), `client console should not expose entry: ${label}`);
  }

  const sidebar = source.slice(source.indexOf('<aside'), source.indexOf('</aside>') + '</aside>'.length);
  const workbench = sidebar.indexOf('工作台');
  const devDeploy = sidebar.indexOf('开发与部署');
  const resourceEntry = sidebar.indexOf('资源库');
  assert.ok(workbench >= 0, 'missing workbench section');
  assert.ok(resourceEntry > workbench, 'resource library should not be the workbench entry');
  assert.equal(sidebar.slice(workbench, devDeploy).indexOf('资源库'), -1, 'resource library should not be inside the workbench navigation group');
});
