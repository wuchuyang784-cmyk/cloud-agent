// 平台到独立 Runtime Orchestrator 的无状态控制客户端。
// 生命周期权威状态只在 Runtime control store；本类不保存实例 Map，也不接触 docker.sock。

import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';

import {
  buildStartRequest,
  buildStopRequest,
  parseInspection,
  parseStartConfirmation,
  parseStopConfirmation,
} from '../control-contract.mjs';
import { signControlRequest, verifyControlResponse } from '../control-envelope.mjs';
import { RuntimeDriver, RuntimeDriverError } from './runtime-driver.mjs';

function csv(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function safeHostname(value) {
  return String(value).toLowerCase().replace(/\.$/, '');
}

async function readBoundedBody(response, maximumBytes) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new RuntimeDriverError('orchestrator_response_too_large', '编排器响应超过字节上限');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maximumBytes) throw new RuntimeDriverError('orchestrator_response_too_large', '编排器响应超过字节上限');
  return buffer.toString('utf8');
}

export class RemoteRuntimeDriver extends RuntimeDriver {
  constructor(options = {}) {
    super(options);
    this.orchestratorUrl = options.orchestratorUrl ?? this.env.BAIRUI_RUNTIME_ORCHESTRATOR_URL ?? null;
    this.orchestratorKeyId = options.orchestratorKeyId ?? this.env.BAIRUI_RUNTIME_CONTROL_KEY_ID ?? null;
    this.orchestratorSecret = options.orchestratorSecret ?? this.env.BAIRUI_RUNTIME_CONTROL_SECRET ?? null;
    this.allowedRuntimeHosts = new Set(csv(options.allowedRuntimeHosts ?? this.env.BAIRUI_RUNTIME_ALLOWED_HOSTS).map(safeHostname));
    this.allowedRuntimeCidrs = csv(options.allowedRuntimeCidrs ?? this.env.BAIRUI_RUNTIME_ALLOWED_CIDRS);
    this.runtimeAddressTrust = this.allowedRuntimeCidrs.length ? proxyaddr.compile(this.allowedRuntimeCidrs) : null;
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs ?? this.env.BAIRUI_RUNTIME_CONTROL_TIMEOUT_MS, 10_000, 100, 120_000);
    this.maxResponseBytes = boundedInteger(options.maxResponseBytes ?? this.env.BAIRUI_RUNTIME_CONTROL_MAX_RESPONSE_BYTES, 65_536, 1024, 1_048_576);
    this.allowInsecureHttp = options.allowInsecureHttp === true && this.env.NODE_ENV === 'test';
    this.baseUrl = this.#parseBaseUrl();
  }

  get name() {
    return 'remote';
  }

  canRun() {
    if (!this.orchestratorUrl || !this.orchestratorKeyId || !this.orchestratorSecret
      || !this.baseUrl || !this.requestTimeoutMs || !this.maxResponseBytes
      || (this.allowedRuntimeHosts.size === 0 && !this.runtimeAddressTrust)) {
      return { ok: false, reason: 'Runtime Orchestrator 控制配置不完整或不安全' };
    }
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(this.orchestratorKeyId)
      || typeof this.orchestratorSecret !== 'string'
      || this.orchestratorSecret.length < 32) {
      return { ok: false, reason: 'Runtime Orchestrator 控制配置不完整或不安全' };
    }
    return { ok: true, reason: null };
  }

  async provision(spec = {}) {
    this.#assertAvailable();
    const request = buildStartRequest(spec);
    const path = `/v1/runs/${encodeURIComponent(request.runId)}`;
    const response = await this.#request({ method: 'PUT', path, requestId: spec.requestId, body: JSON.stringify(request) });
    if (!response.ok) throw new RuntimeDriverError('orchestrator_rejected', `编排器拒绝启动：HTTP ${response.status}`);
    const confirmation = parseStartConfirmation(response.body, request);
    this.#assertRuntimeUrl(confirmation.runtimeUrl);
    return confirmation;
  }

  async stop(spec = {}) {
    this.#assertAvailable();
    const request = buildStopRequest(spec);
    const path = `/v1/runs/${encodeURIComponent(request.runId)}/stop`;
    const response = await this.#request({ method: 'POST', path, requestId: spec.requestId, body: JSON.stringify(request) });
    if (!response.ok) throw new RuntimeDriverError('stop_not_confirmed', `编排器未确认停止：HTTP ${response.status}`);
    return parseStopConfirmation(response.body, request);
  }

  async inspect(spec = {}) {
    this.#assertAvailable();
    const validated = buildStartRequest({
      ...spec,
      engine: 'pi',
      resourceSpec: { cpuMillis: 100, memoryBytes: 134217728, pidsLimit: 16, idleTtlSeconds: 60 },
    });
    const expected = { agentId: validated.agentId, runId: validated.runId, runGeneration: validated.runGeneration };
    const path = `/v1/runs/${encodeURIComponent(expected.runId)}`;
    const response = await this.#request({ method: 'GET', path, requestId: spec.requestId, body: '' });
    if (!response.ok) throw new RuntimeDriverError('orchestrator_rejected', `编排器状态查询失败：HTTP ${response.status}`);
    const observation = parseInspection(response.body, expected);
    if (observation.status === 'running') this.#assertRuntimeUrl(observation.runtimeUrl);
    return observation;
  }

  #assertAvailable() {
    const available = this.canRun();
    if (!available.ok) throw new RuntimeDriverError('remote_driver_unavailable', available.reason);
  }

  #parseBaseUrl() {
    if (!this.orchestratorUrl) return null;
    try {
      const url = new URL(this.orchestratorUrl);
      const secure = url.protocol === 'https:' || (this.allowInsecureHttp && url.protocol === 'http:');
      if (!secure || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  #assertRuntimeUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new RuntimeDriverError('runtime_url_forbidden', '编排器返回的 Runtime URL 不在允许范围');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new RuntimeDriverError('runtime_url_forbidden', '编排器返回的 Runtime URL 不在允许范围');
    }
    const hostname = safeHostname(url.hostname.replace(/^\[|\]$/g, ''));
    const allowedHost = this.allowedRuntimeHosts.has(hostname);
    const allowedAddress = isIP(hostname) !== 0 && this.runtimeAddressTrust?.(hostname, 0) === true;
    if (!allowedHost && !allowedAddress) {
      throw new RuntimeDriverError('runtime_url_forbidden', '编排器返回的 Runtime URL 不在允许范围');
    }
  }

  async #request({ method, path, requestId, body }) {
    const headers = {
      accept: 'application/json',
      ...signControlRequest({
        method,
        path,
        body,
        requestId,
        keyId: this.orchestratorKeyId,
        secret: this.orchestratorSecret,
      }),
    };
    if (body) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    let timeout;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new RuntimeDriverError('orchestrator_result_unknown', '编排器请求结果未知'));
        }, this.requestTimeoutMs);
      });
      const response = await Promise.race([
        this.fetchImpl(this.baseUrl + path, {
          method,
          headers,
          ...(body ? { body } : {}),
          redirect: 'error',
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      const raw = await readBoundedBody(response, this.maxResponseBytes);
      verifyControlResponse({
        status: response.status,
        requestId,
        body: raw,
        headers: response.headers,
        keys: { [this.orchestratorKeyId]: this.orchestratorSecret },
      });
      if (!String(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        throw new RuntimeDriverError('orchestrator_bad_response', '编排器响应类型无效');
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new RuntimeDriverError('orchestrator_bad_response', '编排器响应不是有效 JSON');
      }
      return { ok: response.ok, status: response.status, body: parsed };
    } catch (error) {
      if (error instanceof RuntimeDriverError || error?.name === 'ControlEnvelopeError') throw error;
      throw new RuntimeDriverError('orchestrator_result_unknown', '编排器请求结果未知');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export default RemoteRuntimeDriver;
