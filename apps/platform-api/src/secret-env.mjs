import { readFile } from 'node:fs/promises';

const keys = ['DATABASE_URL', 'BAIRUI_SESSION_SECRET', 'BETTER_AUTH_SECRET'];

export async function loadSecretEnv(env, read = readFile) {
  if (!env.BAIRUI_SECRET_FILE) return { ...env };
  let text;
  try { text = await read(env.BAIRUI_SECRET_FILE, 'utf8'); }
  catch { throw new Error('secret_file_unavailable'); }
  let data;
  try {
    if (typeof text !== 'string' || text.length > 16384) throw new Error();
    data = JSON.parse(text);
    if (!data || Array.isArray(data) || Object.keys(data).length !== keys.length) throw new Error();
    if (!keys.every(key => typeof data[key] === 'string' && data[key].length >= 32)) throw new Error();
    const url = new URL(data.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2) throw new Error();
  } catch { throw new Error('invalid_secret_file'); }
  for (const key of keys) {
    if (env[key] && env[key] !== data[key]) throw new Error('secret_environment_conflict');
  }
  return { ...env, ...data };
}
