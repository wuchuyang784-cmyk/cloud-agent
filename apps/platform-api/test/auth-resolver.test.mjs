import test from 'node:test';
import assert from 'node:assert/strict';

import { createPrincipalResolver } from '../src/auth/resolver.mjs';
import { MemoryStore } from '../src/store.mjs';

test('dev 模式返回开发身份替身，且具备完整契约方法', () => {
  const resolver = createPrincipalResolver(new MemoryStore(), { env: { NODE_ENV: 'development' }, mode: 'dev' });
  for (const method of ['resolve', 'login', 'clear', 'cookie', 'expiredCookie']) {
    assert.equal(typeof resolver[method], 'function', `缺少契约方法 ${method}`);
  }
});

test('生产环境显式选择开发身份替身时拒绝启动', () => {
  assert.throws(
    () => createPrincipalResolver(new MemoryStore(), { env: { NODE_ENV: 'production' }, mode: 'dev' }),
    /禁止使用开发身份替身/,
  );
});

test('生产环境默认使用本地账号模式并具备注册能力', () => {
  const resolver = createPrincipalResolver(new MemoryStore(), { env: { NODE_ENV: 'production' } });
  assert.equal(typeof resolver.register, 'function');
});

test('隔离测试环境可显式放行开发身份替身', () => {
  const resolver = createPrincipalResolver(new MemoryStore(), {
    env: { NODE_ENV: 'production' },
    mode: 'dev',
    allowDevInProduction: true,
  });
  assert.equal(typeof resolver.resolve, 'function');
});

test('未知的身份解析模式直接报错', () => {
  assert.throws(
    () => createPrincipalResolver(new MemoryStore(), { env: {}, mode: 'bogus' }),
    /不支持的身份解析模式/,
  );
});

test('未登录请求 resolve 返回 null', async () => {
  const resolver = createPrincipalResolver(new MemoryStore(), { env: { NODE_ENV: 'development' }, mode: 'dev' });
  const principal = await resolver.resolve({ headers: {} });
  assert.equal(principal, null);
});

test('伪造的会话 cookie 无法通过签名校验', async () => {
  const resolver = createPrincipalResolver(new MemoryStore(), { env: { NODE_ENV: 'development' }, mode: 'dev' });
  const principal = await resolver.resolve({ headers: { cookie: 'bairui_session=fake-session-id.fake-signature' } });
  assert.equal(principal, null);
});
