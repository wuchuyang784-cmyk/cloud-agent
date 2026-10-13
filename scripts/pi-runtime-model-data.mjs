import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Upstream excludes generated provider JSON from Git. Use data (never JS) from
// its immutable, same-version release; still run upstream's model-data validator.
export const modelCatalog = Object.freeze({
  version: '1.1.0', entryCount: 43,
  url: 'https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.1.0.tgz',
  integrity: 'sha512-1T7LAkc/5Bvc0v6w4vAGVdCrli0o/E0pEmYKTnixu95vSFArBjvbhS/G4ZwI0RUePgf0Imcu0VyqlM4EcXxqfw==',
});

export function extractModelData(bytes) {
  if (bytes.length > 8 * 1024 * 1024 || 'sha512-' + createHash('sha512').update(bytes).digest('base64') !== modelCatalog.integrity) {
    throw new Error('pi_catalog_integrity');
  }
  const tar = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }), entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
    if (!name) break;
    const sizeString = header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim();
    if (!/^[0-7]+$/.test(sizeString)) throw new Error('pi_catalog_tar_invalid');
    const size = parseInt(sizeString, 8), start = offset + 512;
    if (start + size > tar.length) throw new Error('pi_catalog_tar_invalid');
    if (name.startsWith('package/dist/providers/data/')) {
      const file = name.slice('package/dist/providers/data/'.length);
      if (!/^(?:\.manifest|[a-z][a-z0-9-]*)\.json$/.test(file) || size > 1024 * 1024
        || entries.has(file) || ![0, 48].includes(header[156])) throw new Error('pi_catalog_entry_invalid');
      const content = tar.subarray(start, start + size), value = JSON.parse(content.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pi_catalog_json_invalid');
      entries.set(file, content);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (entries.size !== modelCatalog.entryCount || !entries.has('.manifest.json')) throw new Error('pi_catalog_missing');
  const manifest = JSON.parse(entries.get('.manifest.json'));
  for (const [name, content] of entries) {
    if (name === '.manifest.json') continue;
    if (manifest.files?.[name] !== createHash('sha256').update(content).digest('hex')) throw new Error('pi_catalog_manifest_invalid');
  }
  return entries;
}

export async function prepareModelData({ output, cache }) {
  await mkdir(cache, { recursive: true });
  const cached = join(cache, `pi-ai-${modelCatalog.version}.tgz`);
  let bytes = await readFile(cached).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!bytes) {
    const response = await fetch(modelCatalog.url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('pi_catalog_download_failed');
    let length = 0; const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 8 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('pi_catalog_oversized'); }
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  const entries = extractModelData(bytes);
  await writeFile(cached, bytes); await mkdir(output, { recursive: true });
  for (const [name, content] of entries) await writeFile(join(output, name), content);
  return { ...modelCatalog, tarSha256: createHash('sha256').update(bytes).digest('hex'),
    files: Object.fromEntries([...entries].map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')])) };
}
