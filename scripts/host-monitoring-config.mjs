import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const hostExporterImage = 'prom/node-exporter:v1.10.2@sha256:3ac34ce007accad95afed72149e0d2b927b7e42fd1c866149b945b84737c62c3';
export const hostNames = Object.freeze({ exporter: 'bairui-host-exporter', sampler: 'bairui-host-sampler', bridge: 'bairui-host-metrics', volume: 'bairui-monitor-host-cache' });
export const hostComponentLabel = 'bairui.monitoring.host';
export const hostReleaseLabel = 'bairui.monitoring.host.revision';
export function assertNativeHost(platform, info) {
  assert.equal(platform, 'linux', 'M1 managed host monitoring requires native Linux, not a Windows Docker VM');
  assert.equal(info?.OSType, 'linux');
  assert.ok(!/docker desktop|docker-desktop|linuxkit/i.test((info.OperatingSystem ?? '') + ' ' + (info.Name ?? '')), 'Docker Desktop must not be presented as the physical host');
}

function mountRows(text) {
  assert.equal(typeof text, 'string'); assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024, 'host_mountinfo_too_large');
  return text.trim().split('\n').filter(Boolean).map(line => {
    const [before, after] = line.split(' - '); assert.ok(after, 'host_mountinfo_invalid');
    const fields = before.split(' '); assert.ok(fields.length >= 6, 'host_mountinfo_invalid');
    return { path: fields[4].replace(/\\(040|011|012|134)/g, (_, value) => String.fromCharCode(parseInt(value, 8))), options: fields[5].split(','), optional: fields.slice(6) };
  });
}

export function assertHostMountPrerequisites(kernel, mountinfo) {
  const version = /^(\d+)\.(\d+)\./.exec(kernel ?? '');
  assert.ok(version && (Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2]) >= 12)), 'host_metrics_requires_linux_kernel_5_12_or_later');
  const root = mountRows(mountinfo).find(row => row.path === '/');
  assert.ok(root?.optional.some(value => /^(?:shared|master):\d+$/.test(value)), 'host_metrics_requires_shared_or_slave_root_no_automatic_host_mount_changes');
}

export function assertHostRootReadonly(mountinfo) {
  const rows = mountRows(mountinfo).filter(row => row.path === '/host' || row.path.startsWith('/host/'));
  assert.ok(rows.some(row => row.path === '/host'), 'host_metrics_root_mount_missing');
  assert.ok(rows.every(row => row.options.includes('ro') && !row.options.includes('rw')), 'host_metrics_submount_not_readonly');
}
export function hostScrapeJob() {
  return { job_name: 'bairui-host', static_configs: [{ targets: ['bairui-host-metrics:9100'], labels: { bairui_host_source: 'linux-host' } }],
    scrape_interval: '15s', scrape_timeout: '5s', sample_limit: 5000, label_limit: 12, label_value_length_limit: 256, body_size_limit: '512KB' };
}
export function hostContainerArgs({ installation, revision, sourcePath, release = revision, names = hostNames, network = 'bairui-preprod-monitor' }) {
  assert.match(installation, /^[a-f0-9]{24}$/); assert.match(revision, /^[a-f0-9]{16}$/);
  assert.match(release, /^(?:[a-f0-9]{16}|[a-f0-9]{64})$/);
  assert.match(sourcePath, /^(?:[A-Za-z]:\/|\/)[A-Za-z0-9_./ -]+\/host-metrics-bridge\.mjs$/);
  assert.ok(!sourcePath.includes('/../') && !sourcePath.includes('/./'));
  for (const key of ['exporter', 'sampler', 'bridge', 'volume']) assert.match(names[key], /^[a-z][a-z0-9-]{2,100}$/);
  assert.equal(new Set(Object.values(names)).size, 4); assert.match(network, /^[a-z][a-z0-9-]{2,100}$/);
  const base = (kind, memory, cpu) => ['run', '-d', '--pull=never', '--name', names[kind], '--label', 'bairui.preprod.installation=' + installation,
    '--label', hostComponentLabel + '=' + kind, '--label', hostReleaseLabel + '=' + release, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--init', '--restart=unless-stopped',
    '--memory=' + memory, '--cpus=' + cpu, '--pids-limit=64', '--log-driver=json-file', '--log-opt=max-size=5m', '--log-opt=max-file=2'];
  const node = 'bairui/platform-api-preprod:' + revision;
  const code = ['--mount', 'type=bind,source=' + sourcePath + ',target=/app/host-metrics-bridge.mjs,readonly', '--entrypoint=node', node, '/app/host-metrics-bridge.mjs'];
  return {
    exporter: [...base('exporter', '64m', '0.20'), '--user=65534:65534', '--network=host', '--pid=host',
      '--mount', 'type=bind,source=/,target=/host,readonly,bind-propagation=rslave',
      hostExporterImage, '--web.listen-address=127.0.0.1:19100', '--web.disable-exporter-metrics', '--path.rootfs=/host', '--collector.disable-defaults',
      ...['cpu', 'meminfo', 'stat', 'time', 'filesystem', 'diskstats', 'netdev'].map(name => '--collector.' + name),
      '--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|run|var/lib/docker|var/lib/containers)($|/)',
      '--collector.netdev.device-exclude=^(lo|docker.*|br-.*|veth.*|vxlan.*|tun.*|tap.*|tailscale.*)$',
      '--collector.diskstats.device-exclude=^(ram|loop|fd|sr)[0-9]+$', '--log.level=warn'],
    sampler: [...base('sampler', '96m', '0.15'), '--user=1000:1000', '--network=host', '--mount', 'type=volume,source=' + names.volume + ',target=/data', ...code, 'sampler'],
    bridge: [...base('bridge', '96m', '0.15'), '--user=1000:1000', '--network=' + network, '--network-alias=bairui-host-metrics',
      '--mount', 'type=volume,source=' + names.volume + ',target=/data,readonly', ...code, 'bridge'],
  };
}

export function hostReleaseRevision(input, sourceCode) {
  assert.equal(typeof sourceCode, 'string'); assert.ok(Buffer.byteLength(sourceCode) <= 1024 * 1024);
  return createHash('sha256').update(JSON.stringify(hostContainerArgs(input))).update(sourceCode).digest('hex');
}

export function hostCacheInitializationArgs({ installation, revision, volume = hostNames.volume }) {
  assert.match(installation, /^[a-f0-9]{24}$/); assert.match(revision, /^[a-f0-9]{16}$/); assert.match(volume, /^[a-z][a-z0-9-]{2,100}$/);
  const common = ['run', '--rm', '--network=none', '--label', 'bairui.preprod.installation=' + installation, '--label', hostComponentLabel + '=initialize',
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--mount', 'type=volume,source=' + volume + ',target=/data'];
  return [
    [...common, '--user=0:0', '--cap-add=CHOWN', '--entrypoint=node', 'bairui/platform-api-preprod:' + revision, '-e', "require('node:fs').chownSync('/data',1000,1000)"],
    [...common, '--user=1000:1000', '--entrypoint=node', 'bairui/platform-api-preprod:' + revision, '-e', "const fs=require('node:fs');for(const name of ['snapshot.json','snapshot.tmp']){try{fs.unlinkSync('/data/'+name)}catch(e){if(e.code!=='ENOENT')throw e}}"],
  ];
}
