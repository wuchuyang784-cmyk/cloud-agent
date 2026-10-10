import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const exec = promisify(execFile);
export const OWNER_LABEL = 'io.bairui.orchestrator.installation';
const RUN_LABEL = 'io.bairui.orchestrator.run';
const IDENTITY_LABEL = 'io.bairui.orchestrator.identity';
const PROFILE_LABEL = 'io.bairui.orchestrator.profile';
const PROFILE = 'isolation-probe-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const identityHash = row => hash(JSON.stringify([row.agentId, row.runId, row.runGeneration]));
const PROBE = "require('node:http').createServer((q,s)=>{s.writeHead(q.url==='/healthz'?200:404,{'content-type':'application/json'});s.end(JSON.stringify({profile:'isolation-probe-v1'}))}).listen(8092,'0.0.0.0')";
const HEALTH = "const http=require('node:http');const end=Date.now()+4000;function check(){const r=http.get('http://127.0.0.1:8092/healthz',s=>{s.resume();process.exit(s.statusCode===200?0:1)});r.setTimeout(1000,()=>r.destroy());r.on('error',()=>{if(Date.now()>=end)process.exit(1);else setTimeout(check,100)})}check()";

export const containerName = (installationId, runId) => `br-e2-${hash(`${installationId}:${runId}`).slice(0, 40)}`;
function validate(options) {
  if (!/^[a-z0-9-]{8,48}$/.test(options.installationId ?? '') || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(options.network ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(options.image ?? '')) throw new Error('docker_config_invalid');
}
export function createArguments(options, row) {
  validate(options);
  const { cpuMillis, memoryBytes, pidsLimit } = row.request.resourceSpec;
  return ['create', '--pull=never', '--name', containerName(options.installationId, row.runId),
    '--label', `${OWNER_LABEL}=${options.installationId}`, '--label', `${RUN_LABEL}=${hash(row.runId)}`,
    '--label', `${IDENTITY_LABEL}=${identityHash(row)}`, '--label', `${PROFILE_LABEL}=${PROFILE}`,
    '--network', options.network, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--user=1000:1000', `--cpus=${cpuMillis / 1000}`, `--memory=${memoryBytes}`, `--memory-swap=${memoryBytes}`,
    `--pids-limit=${pidsLimit}`, '--restart=no', '--log-driver=none', '--no-healthcheck',
    '--entrypoint=node', options.image, '-e', PROBE];
}

export class DockerOrchestratorDriver {
  constructor({ installationId, network, image, runtimeAddressMode = 'hostname', execute }) {
    this.options = { installationId, network, image };
    validate(this.options);
    if (!['hostname', 'ip'].includes(runtimeAddressMode)) throw new Error('docker_config_invalid');
    this.runtimeAddressMode = runtimeAddressMode;
    this.execute = execute ?? (async args => (await exec('docker', args, {
      windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024,
    })).stdout);
  }
  async #run(args) {
    try { return String(await this.execute(args)).trim(); }
    catch { throw new Error('docker_unknown'); }
  }
  async check() {
    const network = JSON.parse(await this.#run(['network', 'inspect', this.options.network]))[0];
    if (!network?.Internal || network.Labels?.[OWNER_LABEL] !== this.options.installationId) throw new Error('docker_network_invalid');
    const image = JSON.parse(await this.#run(['image', 'inspect', this.options.image]))[0];
    if (image?.Id !== this.options.image || Object.keys(image.Config?.Volumes ?? {}).length) throw new Error('docker_image_invalid');
  }
  async #inspect(row) {
    const name = containerName(this.options.installationId, row.runId);
    // Successful listing distinguishes absence from all CLI/daemon errors.
    let result = '';
    if (row.containerId) {
      if (!/^[a-f0-9]{64}$/.test(row.containerId)) throw new Error('docker_ownership_mismatch');
      result = await this.#run(['ps', '-a', '--no-trunc', '--filter', `id=${row.containerId}`, '--format', '{{.ID}}']);
    }
    if (!result) result = await this.#run(['ps', '-a', '--no-trunc', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
    if (!result) return null;
    if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('docker_result_invalid');
    const info = JSON.parse(await this.#run(['inspect', '--type=container', result]))[0];
    const labels = info?.Config?.Labels;
    if (info?.Id !== result || labels?.[OWNER_LABEL] !== this.options.installationId
      || labels?.[RUN_LABEL] !== hash(row.runId) || labels?.[IDENTITY_LABEL] !== identityHash(row)
      || labels?.[PROFILE_LABEL] !== PROFILE || (row.containerId && row.containerId !== result)) throw new Error('docker_ownership_mismatch');
    return info;
  }
  #validatePolicy(info, row) {
    const host = info.HostConfig; const config = info.Config;
    const resource = row.request.resourceSpec;
    if (info.Image !== this.options.image || config.User !== '1000:1000' || !host.ReadonlyRootfs || host.Privileged
      || host.NanoCpus !== resource.cpuMillis * 1e6 || host.Memory !== resource.memoryBytes || host.MemorySwap !== resource.memoryBytes
      || host.PidsLimit !== resource.pidsLimit || host.NetworkMode !== this.options.network
      || host.RestartPolicy?.Name !== 'no' || host.LogConfig?.Type !== 'none'
      || !host.CapDrop?.includes('ALL') || host.CapAdd?.length || !host.SecurityOpt?.includes('no-new-privileges:true')
      || info.Mounts?.length || Object.keys(host.PortBindings ?? {}).length
      || Object.keys(info.NetworkSettings?.Networks ?? {}).some(name => name !== this.options.network)
      || JSON.stringify(config.Entrypoint) !== JSON.stringify(['node']) || JSON.stringify(config.Cmd) !== JSON.stringify(['-e', PROBE])) {
      throw new Error('docker_policy_mismatch');
    }
  }
  async find(row) {
    const info = await this.#inspect(row);
    if (!info) return null;
    if (!row.terminal && row.request) this.#validatePolicy(info, row);
    const running = info.State?.Running === true;
    let runtimeUrl;
    if (this.runtimeAddressMode === 'hostname') runtimeUrl = `http://${containerName(this.options.installationId, row.runId)}:8092`;
    // A terminal cleanup needs ownership/ID only and must still reclaim a
    // container whose network policy drifted or whose address disappeared.
    else if (running && !row.terminal) {
      const address = info.NetworkSettings?.Networks?.[this.options.network]?.IPAddress;
      if (typeof address !== 'string' || isIP(address) !== 4) throw new Error('docker_runtime_address_invalid');
      runtimeUrl = `http://${address}:8092`;
    }
    return { id: info.Id, running, ...(runtimeUrl ? { runtimeUrl } : {}) };
  }
  async create(row) {
    await this.check();
    // Never adopt a preexisting occupant during a new create operation.
    if (await this.#inspect(row)) throw new Error('docker_name_conflict');
    const id = await this.#run(createArguments(this.options, row));
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('docker_result_invalid');
    return { id };
  }
  async start(row) {
    const info = await this.#inspect(row);
    if (!info || info.Id !== row.containerId) throw new Error('docker_ownership_mismatch');
    this.#validatePolicy(info, row);
    await this.#run(['start', info.Id]);
  }
  async ready(row) {
    const info = await this.#inspect(row);
    if (!info?.State?.Running || info.Id !== row.containerId) throw new Error('runtime_not_ready');
    this.#validatePolicy(info, row);
    await this.#run(['exec', info.Id, 'node', '-e', HEALTH]);
  }
  async remove(row) {
    const info = await this.#inspect(row);
    if (!info) return;
    await this.#run(['rm', '--force', info.Id]);
    if (await this.#inspect(row)) throw new Error('removal_unconfirmed');
  }
}
