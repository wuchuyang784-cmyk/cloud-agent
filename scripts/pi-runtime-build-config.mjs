import { isAbsolute } from 'node:path';

export const piSource = Object.freeze({
  commit: 'c1d4c801114545f47c440921d8b3e04aeb1e565d', version: '0.85.1',
  lockSha256: 'f7e0d7faf7293581715d53ddf3f76bbb7dc14d79ded9c2ac1303756c21e9fed1',
  baseImage: 'docker.m.daocloud.io/library/node@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553',
});

export function validatePiSource(source) {
  if (source.status !== '') throw new Error('pi_source_dirty');
  if (source.gitlink !== piSource.commit || source.stagedGitlink !== piSource.commit || source.head !== piSource.commit
    || source.version !== piSource.version || source.lockSha256 !== piSource.lockSha256) throw new Error('pi_source_unreviewed');
}

export function piBuildArguments({ context, tag, platform = 'linux/amd64', target }) {
  if (!isAbsolute(context ?? '') || !/^bairui\/pi-runtime-f1:[a-z0-9][a-z0-9_.-]{0,100}$/.test(tag ?? '')
    || !['linux/amd64', 'linux/arm64'].includes(platform) || (target !== undefined && target !== 'pi-builder')) throw new Error('pi_build_arguments_invalid');
  return ['build', '--platform', platform, '--build-arg', 'BASE_IMAGE=' + piSource.baseImage,
    '--label', 'io.bairui.pi.source=' + piSource.commit,
    '--label', 'io.bairui.pi.lock=' + piSource.lockSha256,
    '--tag', tag, ...(target ? ['--target', target] : []), context];
}
