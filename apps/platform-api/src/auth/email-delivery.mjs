import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { safeLog } from '../observability/safe-log.mjs';

export const emailAddress = value => typeof value === 'string' && value.length <= 254 && value.trim() === value
  && /^[^\s@<>\x00-\x1f\x7f]+@[^\s@<>\x00-\x1f\x7f]+\.[^\s@<>\x00-\x1f\x7f]+$/.test(value);

export function authEmailMode(env) {
  const mode = env.BAIRUI_AUTH_EMAIL_MODE ?? 'off';
  if (!['off', 'transition', 'enforce'].includes(mode)) throw new Error('auth_email_configuration_invalid');
  return mode;
}

export function readMailConfig(env) {
  let fd;
  try {
    const file = env.BAIRUI_AUTH_MAIL_SECRET_FILE;
    const from = env.BAIRUI_AUTH_MAIL_FROM;
    if (!emailAddress(from) || !file || !isAbsolute(file)) throw Error();
    const named = lstatSync(file);
    if (!named.isFile() || named.size > 257) throw Error();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) throw Error();
    const buffer = Buffer.alloc(259);
    let used = 0;
    while (used < buffer.length) {
      const size = readSync(fd, buffer, used, buffer.length - used);
      if (!size) break;
      used += size;
    }
    const key = buffer.subarray(0, used).toString('utf8').replace(/\r?\n$/, '');
    if (used === buffer.length || key.trim() !== key || !/^re_[A-Za-z0-9_-]{8,250}$/.test(key)) throw Error();
    return { from, key };
  } catch { throw new Error('auth_email_configuration_invalid'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function createResendSender({ from, key }, transport = fetch) {
  return async ({ to, kind, link }) => {
    try {
      const verify = kind === 'verify';
      const result = await transport('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject: verify ? '百睿云：验证邮箱' : '百睿云：重置密码',
          text: (verify ? '打开链接并确认你的邮箱（24 小时内有效）：' : '打开链接并设置新密码（30 分钟内有效）：')
            + '\n' + link + '\n\n如果不是你发起的，请忽略此邮件。' }),
      });
      await result.body?.cancel();
      if (!result.ok) throw Error();
    } catch { throw new Error('auth_email_delivery_failed'); }
  };
}

// Bounded in-process queue. A restart may lose a pending delivery; the user can resend.
export function createEmailQueue(work, limit = 32, parallel = 2) {
  const queued = [];
  let active = 0;
  let scheduled = false;
  function pump() {
    scheduled = false;
    while (active < parallel && queued.length) {
      const job = queued.shift();
      active++;
      Promise.resolve().then(() => work(job)).catch(() => {
        safeLog('auth_email_delivery_failed');
      }).finally(() => { active--; pump(); });
    }
  }
  return job => {
    if (queued.length + active >= limit) { safeLog('auth_email_queue_full', { level: 'warn' }); return; }
    queued.push(job);
    if (!scheduled) { scheduled = true; setImmediate(pump); }
  };
}
