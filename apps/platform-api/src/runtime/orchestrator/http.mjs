import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { signControlResponse, verifyControlRequestAsync } from '../control-envelope.mjs';
import { buildStartRequest, buildStopRequest } from '../control-contract.mjs';

const conflicts = new Set(['run_fenced', 'identity_conflict', 'spec_conflict', 'engine_unsupported']);
const invalid = new Set(['request_invalid', 'runtime_identity_invalid', 'resource_spec_invalid', 'runtime_fence_invalid', 'runtime_reason_invalid', 'runtime_engine_invalid']);
const unavailable = new Set(['creation_uncertain', 'removal_unconfirmed', 'docker_unknown', 'docker_ownership_mismatch', 'docker_policy_mismatch', 'run_busy', 'runtime_not_ready']);
function strictRequest(raw, stop, runId) {
  let input;
  try { input = JSON.parse(raw); } catch { throw new Error('request_invalid'); }
  const fields = stop ? ['agentId', 'runId', 'runGeneration', 'fenceGeneration', 'reason'] : ['agentId', 'runId', 'runGeneration', 'engine', 'resourceSpec'];
  if (!input || typeof input !== 'object' || Object.keys(input).length !== fields.length
    || Object.keys(input).some(key => !fields.includes(key)) || input.runId !== runId) throw new Error('request_invalid');
  return stop ? buildStopRequest(input) : buildStartRequest(input);
}
async function readBody(request) {
  const timer = setTimeout(() => request.destroy(), 5000);
  try {
    let size = 0; const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 65536) throw new Error('request_invalid');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); }
}

export function createOrchestratorServer({ service, nonceStore, keys, tls, allowTestHttp = false, maxConcurrent = 4 }) {
  if (!tls && !allowTestHttp) throw new Error('orchestrator_tls_required');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) throw new Error('concurrency_invalid');
  let active = 0;
  const handler = async (request, response) => {
    if (active >= maxConcurrent) { response.writeHead(503, { connection: 'close' }); response.end(); return; }
    active++;
    let metadata;
    const send = (status, value) => {
      if (response.destroyed) return;
      const body = JSON.stringify(value);
      const signature = metadata ? signControlResponse({ status, requestId: metadata.requestId, requestNonce: metadata.nonce,
        body, keyId: metadata.keyId, secret: keys[metadata.keyId] }) : {};
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...signature });
      response.end(body);
    };
    try {
      const raw = await readBody(request);
      metadata = await verifyControlRequestAsync({ method: request.method, path: request.url, body: raw, headers: request.headers, keys, nonceStore });
      const match = /^\/v1\/runs\/([^/?#]+)(\/stop)?$/.exec(request.url);
      if (!match) { send(404, { error: 'route_not_found' }); return; }
      let runId;
      try { runId = decodeURIComponent(match[1]); } catch { throw new Error('request_invalid'); }
      if (runId.length < 1 || runId.length > 200 || /[\u0000-\u001f\u007f]/.test(runId)) throw new Error('request_invalid');
      let result;
      if (request.method === 'PUT' && !match[2]) result = await service.start(strictRequest(raw, false, runId));
      else if (request.method === 'POST' && match[2]) result = await service.stop(strictRequest(raw, true, runId));
      else if (request.method === 'GET' && !match[2] && raw === '') result = await service.inspect(runId);
      else { send(405, { error: 'method_not_allowed' }); return; }
      send(200, result);
    } catch (error) {
      const code = error.message;
      if (!metadata) send(401, { error: 'control_request_invalid' });
      else if (invalid.has(code)) send(400, { error: code });
      else if (conflicts.has(code)) send(409, { error: code });
      else if (code === 'run_not_found') send(404, { error: code });
      else send(503, { error: unavailable.has(code) ? code : 'orchestrator_unavailable' });
    } finally { active--; }
  };
  const server = tls ? httpsServer({ ...tls, minVersion: 'TLSv1.2' }, handler) : httpServer(handler);
  server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000;
  server.maxConnections = 64; server.maxRequestsPerSocket = 100;
  return server;
}
