import { createServer } from 'node:http';

import {
  MemoryNonceStore,
  signControlResponse,
  verifyControlRequest,
} from '../../src/runtime/control-envelope.mjs';

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 65_536) {
        reject(new Error('request_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

export class FakeRuntimeOrchestrator {
  constructor({ keyId = 'primary', secret }) {
    this.keyId = keyId;
    this.secret = secret;
    this.nonces = new MemoryNonceStore();
    this.runs = new Map();
    this.requests = [];
    this.nextFailure = null;
    this.nextDrop = null;
    this.persistentStopStatus = null;
    this.server = createServer((request, response) => { this.#handle(request, response); });
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  async close() {
    if (!this.server.listening) return;
    await new Promise((resolve) => this.server.close(resolve));
  }

  failNext(method, status = 503) {
    this.nextFailure = { method, status };
  }

  dropNext(method) {
    this.nextDrop = method;
  }

  holdNext(method) {
    let entered; let release;
    const arrived = new Promise(resolve => { entered = resolve; });
    const resumed = new Promise(resolve => { release = resolve; });
    this.nextHold = { method, entered, resumed };
    return { arrived, release };
  }

  failEveryStop(status = 503) {
    this.persistentStopStatus = status;
  }

  run(runId) {
    return structuredClone(this.runs.get(runId) ?? null);
  }

  async #handle(request, response) {
    try {
      const raw = await readBody(request);
      const metadata = verifyControlRequest({
        method: request.method,
        path: request.url,
        body: raw,
        headers: request.headers,
        keys: { [this.keyId]: this.secret },
        nonceStore: this.nonces,
      });
      const body = raw ? JSON.parse(raw) : null;
      response.requestNonce = metadata.nonce;
      this.requests.push({ method: request.method, path: request.url, body });
      if (this.nextHold?.method === request.method) {
        const hold = this.nextHold;
        this.nextHold = null;
        hold.entered();
        await hold.resumed;
      }

      if (this.nextFailure?.method === request.method) {
        const { status } = this.nextFailure;
        this.nextFailure = null;
        this.#json(response, status, metadata.requestId, { error: 'injected_failure' });
        return;
      }
      if (request.method === 'POST' && this.persistentStopStatus) {
        this.#json(response, this.persistentStopStatus, metadata.requestId, { error: 'persistent_stop_failure' });
        return;
      }

      const match = /^\/v1\/runs\/([^/]+)(\/stop)?$/.exec(request.url);
      if (!match) {
        this.#json(response, 404, metadata.requestId, { error: 'route_not_found' });
        return;
      }
      const runId = decodeURIComponent(match[1]);
      if (request.method === 'PUT' && !match[2]) {
        const existing = this.runs.get(runId);
        if (existing && ['stopped', 'absent'].includes(existing.status)) {
          this.#json(response, 409, metadata.requestId, { error: 'run_fenced' });
          return;
        }
        if (existing && JSON.stringify(existing.request) !== JSON.stringify(body)) {
          this.#json(response, 409, metadata.requestId, { error: 'idempotency_conflict' });
          return;
        }
        const run = existing ?? {
          request: structuredClone(body),
          agentId: body.agentId,
          runId: body.runId,
          runGeneration: body.runGeneration,
          status: 'running',
          orchestratorRef: `fake-${body.runId}`,
          runtimeUrl: `http://${body.agentId}.runtime.internal:8092`,
        };
        this.runs.set(runId, run);
        if (this.nextDrop === 'PUT') {
          this.nextDrop = null;
          request.socket.destroy();
          return;
        }
        this.#json(response, 200, metadata.requestId, {
          agentId: run.agentId,
          runId,
          runGeneration: run.runGeneration,
          status: 'running',
          orchestratorRef: run.orchestratorRef,
          runtimeUrl: run.runtimeUrl,
          observedAt: '2026-10-08T00:00:00.000Z',
        });
        return;
      }
      if (request.method === 'GET' && !match[2]) {
        const run = this.runs.get(runId);
        if (!run) {
          this.#json(response, 404, metadata.requestId, { error: 'run_not_found' });
          return;
        }
        this.#json(response, 200, metadata.requestId, {
          agentId: run.agentId,
          runId,
          runGeneration: run.runGeneration,
          status: run.status,
          ...(run.status === 'running' ? { orchestratorRef: run.orchestratorRef, runtimeUrl: run.runtimeUrl } : {}),
          observedAt: '2026-10-08T00:00:01.000Z',
        });
        return;
      }
      if (request.method === 'POST' && match[2]) {
        const run = this.runs.get(runId);
        if (run && (run.agentId !== body.agentId || run.runGeneration !== body.runGeneration)) {
          this.#json(response, 409, metadata.requestId, { error: 'identity_mismatch' });
          return;
        }
        if (run) run.status = 'stopped';
        else this.runs.set(runId, { agentId: body.agentId, runId, runGeneration: body.runGeneration, status: 'absent' });
        if (this.nextDrop === 'POST') {
          this.nextDrop = null;
          request.socket.destroy();
          return;
        }
        this.#json(response, 200, metadata.requestId, {
          agentId: body.agentId,
          runId,
          runGeneration: body.runGeneration,
          status: run ? 'stopped' : 'absent',
          confirmedAt: '2026-10-08T00:00:02.000Z',
        });
        return;
      }
      this.#json(response, 405, metadata.requestId, { error: 'method_not_allowed' });
    } catch {
      if (!response.headersSent) response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'control_request_invalid' }));
    }
  }

  #json(response, status, requestId, value) {
    const raw = JSON.stringify(value);
    response.writeHead(status, {
      'content-type': 'application/json',
      ...signControlResponse({ status, requestId, requestNonce: response.requestNonce, body: raw, keyId: this.keyId, secret: this.secret }),
    });
    response.end(raw);
  }
}
