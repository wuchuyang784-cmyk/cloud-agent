import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
let config;

before(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bairui-console-dev-'));
  const previousDirectory = process.cwd();
  try {
    // The config calls loadEnv; use an empty directory to avoid business .env files.
    process.chdir(directory);
    // Native loading avoids a bundler child retaining the temporary cwd on Windows.
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, join(root, 'vite.config.ts'), directory, undefined, undefined, 'native');
    assert.ok(loaded, 'Vite config must load');
    config = loaded.config;
  } finally {
    process.chdir(previousDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});

async function developmentServer(t, port = 0) {
  const tempRoot = resolve(tmpdir());
  const cacheDir = await mkdtemp(join(tempRoot, 'bairui-console-cache-'));
  assert.equal(dirname(cacheDir), tempRoot);
  let server;
  t.after(async () => {
    try {
      await server?.close();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
  // Concurrent tests must never replace the running console's optimized dependencies.
  server = await createServer({
    ...config,
    root,
    cacheDir,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...config.server, port, watch: null, hmr: false, preTransformRequests: false },
  });
  return server;
}

test('console dev defaults match the address printed by dev.ps1', () => {
  assert.equal(config.server.host, '127.0.0.1');
  assert.equal(config.server.port, 5173);
  assert.equal(config.server.strictPort, true);
});

test('test servers isolate caches from the running console and each other', { timeout: 20000 }, async t => {
  const first = await developmentServer(t);
  const second = await developmentServer(t);
  const applicationCache = resolve(root, 'node_modules/.vite');
  assert.notEqual(resolve(first.config.cacheDir), applicationCache);
  assert.notEqual(resolve(second.config.cacheDir), applicationCache);
  assert.notEqual(resolve(first.config.cacheDir), resolve(second.config.cacheDir));
});

test('console dev server serves the page over IPv4 loopback', { timeout: 20000 }, async t => {
  const server = await developmentServer(t);
  await server.listen();
  const { port } = server.httpServer.address();
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<div id="root"><\/div>/);
});

test('console dev server fails instead of silently changing an occupied port', { timeout: 20000 }, async t => {
  const first = await developmentServer(t);
  await first.listen();
  const { port } = first.httpServer.address();
  const second = await developmentServer(t, port);
  await assert.rejects(second.listen(), /already in use/);
});
