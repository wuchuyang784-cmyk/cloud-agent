import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise actual Node ESM evaluation, which VM/text-based deployment tests do not cover.
// Docker is replaced at the process boundary; no real service or repository state is touched.
for (const entry of ['preprod.mjs', 'monitoring.mjs']) {
  test(`${entry}: entry module finishes loading while its CLI action is pending`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bairui-cli-loading-'));
    try {
      await mkdir(join(dir, 'scripts'));
      await mkdir(join(dir, 'output', 'preprod'), { recursive: true });
      for (const file of ['preprod.mjs', 'preprod-config.mjs', 'monitoring.mjs', 'monitoring-config.mjs', 'monitoring-rules.test.mjs', 'cli-keepalive.mjs']) {
        await copyFile(new URL(file, import.meta.url), join(dir, 'scripts', file));
      }
      await writeFile(join(dir, 'output', 'preprod', 'state.json'), JSON.stringify({
        version: 1, installation: 'a'.repeat(24), schemaHash: 'b'.repeat(64),
        phase: 'running', revision: 'c'.repeat(16), monitoring: { enabled: true },
      }));
      const preload = join(dir, 'preload.mjs');
      await writeFile(preload, `
        import childProcess from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { Writable } from 'node:stream';
        import { pathToFileURL } from 'node:url';
        childProcess.execFile = () => {
          console.log('OPERATION_PENDING');
          // This is the same dependency back-edge used by the monitoring integration.
          import(pathToFileURL(process.argv[1]).href).then(() => {
            console.log('ENTRY_MODULE_READY');
            process.exit(0);
          });
          return { stdin: new Writable({ write(chunk, encoding, done) { done(); } }) };
        };
        syncBuiltinESMExports();
      `);
      const result = await new Promise(resolve => execFile(process.execPath,
        ['--import', pathToFileURL(preload).href, join(dir, 'scripts', entry), 'up'],
        { cwd: dir, timeout: 5000, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
      assert.match(result.stdout, /OPERATION_PENDING/, result.stderr);
      assert.equal(result.error, null, 'entry module evaluation deadlocked behind its pending CLI action');
      assert.match(result.stdout, /ENTRY_MODULE_READY/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
