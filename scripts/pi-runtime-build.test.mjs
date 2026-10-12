import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preparePiBuildContext } from './pi-runtime-build.mjs';

const build = await import('./pi-runtime-build-config.mjs').catch(() => ({}));
const catalog = await import('./pi-runtime-model-data.mjs').catch(() => ({}));
const source = { gitlink: 'c1d4c801114545f47c440921d8b3e04aeb1e565d', stagedGitlink: 'c1d4c801114545f47c440921d8b3e04aeb1e565d',
  head: 'c1d4c801114545f47c440921d8b3e04aeb1e565d', status: '', version: '0.85.1', lockSha256: 'f7e0d7faf7293581715d53ddf3f76bbb7dc14d79ded9c2ac1303756c21e9fed1' };

test('source release accepts exactly the reviewed gitlink, HEAD, version and lock', () => {
  assert.equal(typeof build.validatePiSource, 'function');
  assert.doesNotThrow(() => build.validatePiSource(source));
});
test('source release refuses a changed pin, source, version or lock', () => {
  for (const field of ['gitlink', 'stagedGitlink', 'head', 'version', 'lockSha256']) {
    assert.throws(() => build.validatePiSource({ ...source, [field]: 'changed' }), /pi_source_unreviewed/);
  }
  assert.throws(() => build.validatePiSource({ ...source, status: ' M package.json' }), /pi_source_dirty/);
});
test('build arguments restrict platform, preserve distinct image namespace and bind digest', () => {
  assert.equal(typeof build.piBuildArguments, 'function');
  const args = build.piBuildArguments({ context: 'E:/temp/f1-context', tag: 'bairui/pi-runtime-f1:abc123', platform: 'linux/amd64', target: 'pi-builder' });
  assert.ok(args.includes('pi-builder'));
  assert.ok(args.includes('BASE_IMAGE=' + build.piSource.baseImage));
  assert.match(build.piSource.baseImage, /@sha256:[a-f0-9]{64}$/);
  for (const options of [{ tag: 'bairui-agent-pi:0.85.1' }, { platform: 'windows/amd64' }, { target: 'other' }]) {
    assert.throws(() => build.piBuildArguments({ context: 'E:/temp/f1-context', tag: 'bairui/pi-runtime-f1:abc123', platform: 'linux/amd64', ...options }), /pi_build_arguments_invalid/);
  }
});
test('source Dockerfile uses committed archive, ignored install scripts, offline build and non-root runtime', async () => {
  const file = await readFile(new URL('../apps/platform-api/docker/pi/production/Dockerfile', import.meta.url), 'utf8').catch(() => '');
  assert.match(file, /ADD pi-source\.tar/);
  assert.match(file, /npm ci --ignore-scripts/);
  assert.match(file, /npm run build:offline/);
  assert.doesNotMatch(file, /npm install -g|@earendil-works\/pi-coding-agent@|COPY \. /);
  assert.match(file, /USER 1000:1000/);
  assert.match(file, /production\/index\.mjs/);
  assert.match(file, /COPY model-data .*src\/providers\/data/);
  assert.match(file, /c\.listenPort/);
  assert.match(file, /c\.listenHost/);
});

test('model catalog verifies fixed release integrity before considering tar content', () => {
  assert.equal(typeof catalog.extractModelData, 'function');
  assert.throws(() => catalog.extractModelData(Buffer.from('not the release')), /pi_catalog_integrity/);
  assert.match(catalog.modelCatalog.integrity, /^sha512-/);
  assert.equal(catalog.modelCatalog.version, source.version);
});

test('actual build context excludes platform secrets and preserves the source archive', async () => {
  const prepared = await preparePiBuildContext({ builderOnly: true });
  try {
    assert.deepEqual((await readdir(prepared.context)).sort(), ['.dockerignore', 'Dockerfile', 'model-data', 'pi-source.tar', 'production', 'provenance.json'].sort());
    assert.equal(prepared.provenance.sourceCommit, source.head);
    assert.equal(Object.keys(prepared.provenance.modelCatalog.files).length, 40);
    assert.equal((await readdir(join(prepared.context, 'model-data'))).length, 40);
    const { stdout } = await promisify(execFile)('tar', ['-tf', join(prepared.context, 'pi-source.tar')], { maxBuffer: 1024 * 1024, windowsHide: true });
    const files = stdout.split(/\r?\n/).filter(Boolean);
    assert.ok(files.includes('packages/coding-agent/src/cli.ts'));
    assert.ok(files.every(name => !name.startsWith('.git/') && !name.startsWith('output/') && !/(^|\/)\.env$/.test(name)));
  } finally { await rm(prepared.context, { recursive: true, force: true }); }
});
