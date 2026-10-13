import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preparePiBuildContext } from './pi-runtime-build.mjs';

const build = await import('./pi-runtime-build-config.mjs').catch(() => ({}));
const catalog = await import('./pi-runtime-model-data.mjs').catch(() => ({}));
const source = { gitlink: '11f99114506ad2cc759cb389663edaf7546cbe8c', stagedGitlink: '11f99114506ad2cc759cb389663edaf7546cbe8c',
  head: '11f99114506ad2cc759cb389663edaf7546cbe8c', status: '', version: '1.1.0', lockSha256: '7b597edc7527a36d9fba52f7e0fc9732447065fd96e4e6abc976cdcd14676b6b' };

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
test('source release accepts only the exact staged gitlink transition before parent commit', () => {
  assert.doesNotThrow(() => build.validatePiSource({ ...source, gitlink: build.piSource.previousCommit }));
  assert.throws(() => build.validatePiSource({ ...source, gitlink: 'another-old-pin' }), /pi_source_unreviewed/);
  assert.throws(() => build.validatePiSource({ ...source, gitlink: build.piSource.previousCommit, stagedGitlink: build.piSource.previousCommit }), /pi_source_unreviewed/);
});
test('build arguments restrict platform, preserve distinct image namespace and bind digest', () => {
  assert.equal(typeof build.piBuildArguments, 'function');
  const context = join(tmpdir(), 'f1-context');
  const args = build.piBuildArguments({ context, tag: 'bairui/pi-runtime-f1:abc123', platform: 'linux/amd64', target: 'pi-builder' });
  assert.ok(!args.includes('--allow'));
  assert.ok(args.includes('pi-builder'));
  assert.ok(args.includes('BASE_IMAGE=' + build.piSource.baseImage));
  assert.match(build.piSource.baseImage, /@sha256:[a-f0-9]{64}$/);
  for (const options of [{ tag: 'bairui-agent-pi:1.1.0' }, { platform: 'windows/amd64' }, { target: 'other' }]) {
    assert.throws(() => build.piBuildArguments({ context, tag: 'bairui/pi-runtime-f1:abc123', platform: 'linux/amd64', ...options }), /pi_build_arguments_invalid/);
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
  assert.match(file, /mirrors\.aliyun\.com\/debian/);
  assert.match(file, /Acquire::Retries "2"/);
  assert.match(file, /Acquire::http::Timeout "20"/);
  assert.doesNotMatch(file, /--network=host/);
  assert.match(file, /c\.listenPort/);
  assert.match(file, /c\.listenHost/);
});

test('model catalog verifies fixed release integrity before considering tar content', () => {
  assert.equal(typeof catalog.extractModelData, 'function');
  assert.throws(() => catalog.extractModelData(Buffer.from('not the release')), /pi_catalog_integrity/);
  assert.match(catalog.modelCatalog.integrity, /^sha512-/);
  assert.equal(catalog.modelCatalog.version, source.version);
  assert.equal(catalog.modelCatalog.entryCount, 43);
});

test('actual build context excludes platform secrets and preserves the source archive', async () => {
  const prepared = await preparePiBuildContext({ builderOnly: true });
  try {
    assert.deepEqual((await readdir(prepared.context)).sort(), ['.dockerignore', 'Dockerfile', 'model-data', 'pi-source.tar', 'production', 'provenance.json'].sort());
    assert.equal(prepared.provenance.sourceCommit, source.head);
    assert.equal(Object.keys(prepared.provenance.modelCatalog.files).length, 43);
    assert.equal((await readdir(join(prepared.context, 'model-data'))).length, 43);
    const { stdout } = await promisify(execFile)('tar', ['-tf', join(prepared.context, 'pi-source.tar')], { maxBuffer: 1024 * 1024, windowsHide: true });
    const files = stdout.split(/\r?\n/).filter(Boolean);
    assert.ok(files.includes('packages/coding-agent/src/cli.ts'));
    assert.ok(files.every(name => !name.startsWith('.git/') && !name.startsWith('output/') && !/(^|\/)\.env$/.test(name)));
  } finally { await rm(prepared.context, { recursive: true, force: true }); }
});
