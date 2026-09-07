// Runtime Boundary 契约服务骨架（docs/20 §4 / docs/28 §2）。
// Boundary 是平台与引擎之间的受信网关：平台以共享密钥签名信封后 POST
// /v1/runtime/operations 或 /v1/runtime/streams，Boundary 校验签名/时间窗/nonce
// 后再将操作下发到具体引擎实例。
//
// 骨架阶段：真实引擎未接入（见 engines/dsh-engine.mjs、pi-engine.mjs），签名
// 通过后返回 accepted；后续填充“按 envelope.agentId 查 agent_engine_runs 的
// runtime_url 并转发”的引擎调用段即可。
//
// 信封 JSON body 约定（与 docs/20 §4 一致）：
// { organizationId, agentId, userId, role, operation, traceId, createdAt, engine }
// 请求头：x-bairui-timestamp / x-bairui-nonce / x-bairui-signature。

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { verifyEnvelope } from './boundary-envelope.mjs';

const RUNTIME_PATHS = new Set(['/v1/runtime/operations', '/v1/runtime/streams']);

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text);
    });
    request.on('error', reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function createBoundaryServer(options = {}) {
  const secret = options.secret ?? process.env.RUNTIME_SHARED_SECRET ?? 'local-only-change-this-secret';
  const nonceWindowMs = options.nonceWindowMs ?? 5 * 60 * 1000;
  const seenNonces = options.seenNonces ?? new Set();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://boundary.local');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json(response, 200, { status: 'ok', service: 'bairui-runtime-boundary' });
    }
    if (request.method !== 'POST' || !RUNTIME_PATHS.has(url.pathname)) {
      return json(response, 404, { error: 'not_found', code: 'route_not_found' });
    }

    let body;
    try {
      body = await readBody(request);
    } catch {
      return json(response, 400, { error: 'read_failed', code: 'invalid_body' });
    }

    const verification = verifyEnvelope({
      secret,
      timestamp: request.headers['x-bairui-timestamp'],
      nonce: request.headers['x-bairui-nonce'],
      signature: request.headers['x-bairui-signature'],
      body,
      nonceWindowMs,
      seenNonces,
    });
    if (!verification.ok) {
      return json(response, 401, { error: 'envelope_invalid', code: verification.error });
    }

    let envelope;
    try {
      envelope = JSON.parse(body || '{}');
    } catch {
      return json(response, 400, { error: 'invalid_json', code: 'invalid_body' });
    }
    if (typeof envelope.operation !== 'string' || typeof envelope.agentId !== 'string') {
      return json(response, 422, { error: 'envelope_required', code: 'missing_operation_or_agent_id' });
    }

    // TODO(engine)：按 envelope.agentId 解析 agent_engine_runs.runtime_url，将
    // operation 转发到对应引擎实例（HTTP/SSE），并把引擎响应原样回传。
    return json(response, 202, {
      status: 'accepted',
      traceId: envelope.traceId ?? null,
      agentId: envelope.agentId,
      operation: envelope.operation,
      engine: envelope.engine ?? 'unknown',
      forwardedTo: null,
    });
  });

  return server;
}

// 直接运行时启动：npm run start:boundary --prefix apps/platform-api
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8091);
  const server = createBoundaryServer();
  server.listen(port, '0.0.0.0', () => console.log('runtime-boundary listening on :' + port));
}
