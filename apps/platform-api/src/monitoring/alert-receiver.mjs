import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import fs from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 3;
const ALERT_NAMES = new Set(['ApiReplicaMissing', 'DatabaseUnavailable', 'ApiErrorRateHigh',
  'ApiLatencyHigh', 'DatabasePoolWaiting', 'MonitoringTargetDown', 'AlertDeliveryFailed']);
const SEVERITIES = new Set(['info', 'warning', 'critical']);
const STATUSES = new Set(['firing', 'resolved']);
const MONITOR_INSTANCES = new Set(['localhost:9090', 'bairui-monitor_alertmanager:9093', 'bairui-monitor_grafana:3000']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = status => Object.assign(new Error('alert_request_rejected'), { status });
const digest = value => createHash('sha256').update(value).digest();
const recordPath = (directory, index = 0) => join(directory, index ? `alerts.${index}.jsonl` : 'alerts.jsonl');

function boundedInteger(value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('invalid_alert_limit');
  return value;
}

function sanitizeInstance(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) throw failure(400);
  if (MONITOR_INSTANCES.has(value)) return value;
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([0-9.]+)):([0-9]{1,5})$/.exec(value);
  if (!match || isIP(match[1] ?? match[2]) !== (match[1] ? 6 : 4)
    || Number(match[3]) < 1 || Number(match[3]) > 65535) throw failure(400);
  return match[1] ? `[${match[1].toLowerCase()}]:${Number(match[3])}` : `${match[2]}:${Number(match[3])}`;
}

function sanitizedRecord(receivedAt, status, labels) {
  if (!STATUSES.has(status) || !object(labels) || !ALERT_NAMES.has(labels.alertname)
    || !SEVERITIES.has(labels.severity)) throw failure(400);
  return { receivedAt, alertname: labels.alertname, severity: labels.severity, status,
    instance: sanitizeInstance(labels.instance) };
}

function webhookRecords(body) {
  let data;
  try { data = JSON.parse(body); } catch { throw failure(400); }
  if (!object(data) || data.version !== '4' || !STATUSES.has(data.status)
    || !Array.isArray(data.alerts) || data.alerts.length < 1 || data.alerts.length > 64) throw failure(400);
  const receivedAt = new Date().toISOString();
  return data.alerts.map(alert => {
    if (!object(alert)) throw failure(400);
    return sanitizedRecord(receivedAt, alert.status, alert.labels);
  });
}

function readBody(request, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const cleanup = () => {
      request.off('data', data);
      request.off('end', end);
      request.off('aborted', aborted);
      request.off('error', fail);
      signal.removeEventListener('abort', cancelled);
    };
    const fail = error => { cleanup(); reject(error); };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) fail(failure(413));
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const aborted = () => fail(failure(400));
    const cancelled = () => fail(signal.reason);
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', fail);
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}

function respond(request, response, status) {
  if (response.destroyed || response.writableEnded) return;
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' };
  if (status === 401) headers['www-authenticate'] = 'Bearer';
  if (status === 503) headers['retry-after'] = '5';
  response.writeHead(status, headers);
  request.resume();
  response.end(JSON.stringify({ status: status === 200 ? 'ok' : 'rejected' }));
}

async function readBounded(file, maximum) {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > maximum) throw new Error('invalid_alert_file');
  const buffer = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function syncDirectory(directory) {
  // Linux volume directory entries must also survive a restart after rotation.
  if (process.platform === 'win32') return;
  const file = await fs.open(directory, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

async function rotate(directory, maxFiles) {
  await fs.rm(recordPath(directory, maxFiles - 1), { force: true });
  for (let index = maxFiles - 2; index >= 0; index--) {
    try { await fs.rename(recordPath(directory, index), recordPath(directory, index + 1)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await syncDirectory(directory);
}

async function appendRecords(directory, records, maxFileBytes, maxFiles) {
  const lines = records.map(record => Buffer.from(JSON.stringify(record) + '\n'));
  if (lines.some(line => line.length > maxFileBytes)) throw new Error('alert_record_too_large');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let index = 0;
  while (index < lines.length) {
    const file = await fs.open(recordPath(directory), 'a+', 0o600);
    let needsRotation = false;
    try {
      const existing = await readBounded(file, maxFileBytes);
      const size = existing.lastIndexOf(10) + 1;
      // Windows append handles cannot truncate; the serialized writer owns this path.
      if (size !== existing.length) await fs.truncate(recordPath(directory), size);
      needsRotation = size + lines[index].length > maxFileBytes;
      if (!needsRotation) {
        const start = index;
        let bytes = size;
        while (index < lines.length && bytes + lines[index].length <= maxFileBytes) {
          bytes += lines[index++].length;
        }
        try {
          await file.writeFile(Buffer.concat(lines.slice(start, index)));
          await file.sync();
        } catch (error) {
          // Do not leave a partially appended batch for the next retry to concatenate.
          try { await fs.truncate(recordPath(directory), size); await file.sync(); } catch { /* The retry rechecks the tail. */ }
          throw error;
        }
      }
    } finally { await file.close(); }
    if (needsRotation) await rotate(directory, maxFiles);
    else await syncDirectory(directory);
  }
}

export function createAlertReceiver({ token, directory, maxFileBytes = MAX_FILE_BYTES,
  maxFiles = MAX_FILES, maxPending = 32 } = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096
    || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error('invalid_alert_token');
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('invalid_alert_directory');
  boundedInteger(maxFileBytes, 256, MAX_FILE_BYTES);
  boundedInteger(maxFiles, 1, MAX_FILES);
  boundedInteger(maxPending, 1, 32);
  const tokenDigest = digest(token);
  let pending = 0;
  let writer = Promise.resolve();
  let closing = false;
  let drained = Promise.resolve();
  let resolveDrained;
  const active = new Set();
  const server = createServer({ requestTimeout: 10000, headersTimeout: 5000,
    keepAliveTimeout: 1000, connectionsCheckingInterval: 1000, maxHeaderSize: 8192 }, async (request, response) => {
    request.on('error', () => {});
    if (request.method === 'GET' && request.url === '/livez') return respond(request, response, 200);
    if (request.method !== 'POST' || request.url !== '/alerts') return respond(request, response, 404);
    const credentials = request.headersDistinct.authorization ?? [];
    const match = credentials.length === 1 && /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(credentials[0]);
    if (!match || !timingSafeEqual(tokenDigest, digest(match[1]))) return respond(request, response, 401);
    if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')
      || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
      return respond(request, response, 415);
    }
    if (Number(request.headers['content-length']) > MAX_BODY_BYTES) return respond(request, response, 413);
    if (closing || pending >= maxPending) return respond(request, response, 503);
    if (pending === 0) drained = new Promise(resolve => { resolveDrained = resolve; });
    pending++;
    const ticket = { controller: new AbortController(), phase: 'body' };
    const { signal } = ticket.controller;
    active.add(ticket);
    const deadline = setTimeout(() => {
      const status = ticket.phase === 'body' ? 408 : 503;
      ticket.controller.abort(failure(status));
      respond(request, response, status);
    }, Math.min(server.requestTimeout || 10000, 10000));
    deadline.unref();
    const disconnected = () => {
      if (!response.writableFinished) ticket.controller.abort(failure(503));
    };
    response.once('close', disconnected);
    try {
      const records = webhookRecords(await readBody(request, signal));
      ticket.phase = 'write';
      const write = writer.then(() => {
        if (signal.aborted) throw signal.reason;
        return appendRecords(directory, records, maxFileBytes, maxFiles);
      });
      writer = write.catch(() => {});
      await write;
      respond(request, response, 200);
    } catch (error) { respond(request, response, error.status ?? 503); }
    finally {
      clearTimeout(deadline);
      response.off('close', disconnected);
      active.delete(ticket);
      if (--pending === 0) resolveDrained();
    }
  });
  const close = server.close.bind(server);
  server.close = callback => {
    closing = true;
    for (const ticket of active) {
      if (ticket.phase === 'body') ticket.controller.abort(failure(503));
    }
    // A timed-out request can still own an uninterruptible filesystem operation.
    close(error => { drained.then(() => callback?.(error)); });
    return server;
  };
  return server;
}

export async function readAlertRecords(directory, limit = 100) {
  boundedInteger(limit, 0, 10000);
  if (limit === 0) return [];
  const records = [];
  for (let index = 0; index < MAX_FILES; index++) {
    let text;
    try {
      const file = await fs.open(recordPath(directory, index), 'r');
      try { text = (await readBounded(file, MAX_FILE_BYTES)).toString('utf8'); }
      finally { await file.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error('alert_records_unavailable');
    }
    const lines = text.split('\n');
    lines.pop();
    for (const line of lines.reverse()) {
      try {
        const record = JSON.parse(line);
        if (typeof record.receivedAt !== 'string' || new Date(record.receivedAt).toISOString() !== record.receivedAt) continue;
        records.push(sanitizedRecord(record.receivedAt, record.status, {
          alertname: record.alertname, severity: record.severity,
          instance: record.instance === null ? undefined : record.instance,
        }));
        if (records.length >= limit) return records;
      } catch { /* Ignore corrupt or incomplete records, never return raw file content. */ }
    }
  }
  return records;
}
