import { isAbsolute } from 'node:path';

export const piSource = Object.freeze({
  commit: '11f99114506ad2cc759cb389663edaf7546cbe8c', version: '1.1.0',
  previousCommit: 'c1d4c801114545f47c440921d8b3e04aeb1e565d',
  lockSha256: '7b597edc7527a36d9fba52f7e0fc9732447065fd96e4e6abc976cdcd14676b6b',
  baseImage: 'docker.m.daocloud.io/library/node@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553',
});

export function validatePiSource(source) {
  if (source.status !== '') throw new Error('pi_source_dirty');
  const committedPin = source.gitlink === piSource.commit && source.stagedGitlink === piSource.commit;
  const stagedUpgrade = source.gitlink === piSource.previousCommit && source.stagedGitlink === piSource.commit;
  if ((!committedPin && !stagedUpgrade) || source.head !== piSource.commit
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
