import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateSandboxProfile } from './profile.mjs';

const MiB = 1024 ** 2;
const CONTROL_RESOURCES = Object.freeze({
  cpuMillis: 250, memoryBytes: 128 * MiB, pidsLimit: 32, tmpfsBytes: 8 * MiB,
});

function digest(parts) {
  // A JSON array avoids ambiguity from concatenated identifiers or separator characters.
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function childPath(root, ...segments) {
  const result = path.posix.join(root, ...segments);
  const relative = path.posix.relative(root, result);
  if (!relative || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error('Invalid sandbox policy');
  }
  return result;
}

function limits({ cpuMillis, memoryBytes, pidsLimit, tmpfsBytes }) {
  return { cpuMillis, memoryBytes, memorySwapBytes: memoryBytes, pidsLimit, tmpfsBytes, nofile: 1024 };
}

function container(image, resources, mounts) {
  return {
    image, user: '1000:1000', readOnlyRootfs: true, capDrop: ['ALL'], noNewPrivileges: true,
    publishedPorts: [], devices: [], resources: limits(resources), mounts,
    tmpfs: [{ target: '/tmp', bytes: resources.tmpfsBytes, mode: '1777', noexec: true, nosuid: true, nodev: true }],
    logging: { driver: 'none' },
  };
}

/**
 * Compile non-executing policy data. A future host driver must verify runsc,
 * gateway egress enforcement, mount ownership and filesystem quotas before use.
 */
export function compileSandboxPolicy(value) {
  const profile = validateSandboxProfile(value);
  const { installationId, identity, resources, storageRoot } = profile;
  const agentHash = digest(['pi-sandbox-agent-v1', installationId, identity.organizationId, identity.ownerUserId, identity.agentId]);
  const runHash = digest(['pi-sandbox-run-v1', agentHash, identity.runId, identity.runGeneration, identity.sessionId]);
  const paths = {
    workspace: childPath(storageRoot, 'agents', agentHash, 'workspace'),
    sessions: childPath(storageRoot, 'agents', agentHash, 'sessions'),
    controlState: childPath(storageRoot, 'agents', agentHash, 'control-state'),
    channel: childPath(storageRoot, 'runs', runHash, 'channel'),
    secrets: childPath(storageRoot, 'runs', runHash, 'secrets'),
  };
  const mount = (source, target, readOnly) => ({ type: 'bind', source, target, readOnly });
  return freeze({
    schemaVersion: 1, installationId, identity,
    names: { sandbox: `pi-sandbox-${runHash}`, control: `pi-control-${runHash}` },
    paths,
    sandbox: {
      ...container(profile.sandboxImage, resources, [
        mount(paths.workspace, '/workspace', false), mount(paths.sessions, '/agent-state', false),
        mount(paths.channel, '/run/channel', true),
      ]),
      runtime: 'runsc', networkMode: 'none',
    },
    control: {
      ...container(profile.controlImage, CONTROL_RESOURCES, [
        mount(paths.controlState, '/control-state', false), mount(paths.channel, '/run/channel', false),
        mount(paths.secrets, '/run/secrets', true),
      ]),
      networkMode: 'trusted-gateway-only', gatewayUrl: profile.gatewayUrl, model: profile.model,
    },
    requirements: {
      runsc: { required: true, hostUds: 'open', fallbackAllowed: false },
      storage: {
        hardQuotaRequired: true,
        quotas: [
          { source: paths.workspace, target: '/workspace', bytes: resources.workspaceBytes,
            inodes: resources.workspaceInodes, enforcement: 'filesystem-hard-quota' },
          { source: paths.sessions, target: '/agent-state', bytes: resources.workspaceBytes,
            inodes: resources.workspaceInodes, enforcement: 'filesystem-hard-quota' },
        ],
        verifyOwnershipAndNoSymlinks: true,
      },
      controlEgress: { required: true, gatewayUrl: profile.gatewayUrl, arbitraryNetworkAllowed: false },
    },
    capacity: {
      admissionImplemented: false,
      sandboxMemoryBytes: resources.memoryBytes, controlMemoryBytes: CONTROL_RESOURCES.memoryBytes,
      sandboxCpuMillis: resources.cpuMillis, controlCpuMillis: CONTROL_RESOURCES.cpuMillis,
      runtimeOverheadBytes: null, runtimeOverheadRequired: true,
    },
  });
}
