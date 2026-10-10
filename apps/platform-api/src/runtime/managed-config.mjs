import { open } from 'node:fs/promises';

const MAXIMUM_BYTES = 32768;
async function readBoundedConfig(path) {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(MAXIMUM_BYTES + 1);
    let size = 0;
    while (size < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, size, bytes.byteLength - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

// The private file is the only source of Runtime credentials. Node's extra CA
// setting must be present before process startup, so it cannot come from JSON.
export async function loadManagedRuntimeEnvironment(env = process.env, readConfig = readBoundedConfig) {
  const path = env.BAIRUI_RUNTIME_CONFIG_FILE;
  if (typeof path !== 'string' || !path || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('runtime_managed_config_file_required');
  let config;
  try {
    const bytes = await readConfig(path);
    if (!Buffer.isBuffer(bytes) || bytes.byteLength > MAXIMUM_BYTES) throw new Error();
    config = JSON.parse(bytes.toString('utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    for (const [key, value] of Object.entries(config)) {
      if (!/^BAIRUI_[A-Z0-9_]+$/.test(key) || key === 'BAIRUI_RUNTIME_CONFIG_FILE'
        || typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
    }
  } catch { throw new Error('runtime_managed_config_invalid'); }
  return { ...(typeof env.NODE_ENV === 'string' ? { NODE_ENV: env.NODE_ENV } : {}),
    ...(typeof env.NODE_EXTRA_CA_CERTS === 'string' ? { NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS } : {}), ...config };
}
