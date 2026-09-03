import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryStore } from './store.mjs';
import { PostgresStore } from './postgres-store.mjs';
import { DevAuth } from './auth.mjs';
import { MockRuntime } from './runtime/mock-runtime.mjs';

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

function sendError(response, status, code, message, requestId) {
  sendJson(response, status, { error: { code, message, requestId } });
}

async function readJson(request, maxBytes = 1024 * 1024) {
  let body = '';
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw new Error('payload_too_large');
    body += chunk;
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('invalid_json');
  }
}

function getRequestId(request) {
  return request.headers['x-request-id'] || 'req_' + randomUUID();
}

function requestHash(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function sendSseHeaders(response) {
  response.writeHead(200, {
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
  });
}

function writeSse(response, event, data) {
  response.write('event: ' + event + '\n');
  response.write('data: ' + JSON.stringify(data) + '\n\n');
}

export const RESOURCE_KINDS = ['knowledge_base', 'skill', 'tool', 'plugin'];

export function createApp(options = {}) {
  const devSeed = process.env.NODE_ENV === 'production' ? {} : {
    users: [{
      id: 'dev-user',
      email: process.env.BAIRUI_DEV_EMAIL ?? 'dev@example.test',
      password: process.env.BAIRUI_DEV_PASSWORD ?? 'dev-password-change-me',
      organizationId: 'dev-org',
      role: 'user',
    }],
    resources: [
      {
        id: 'kb-support-script',
        organizationId: 'dev-org',
        ownerUserId: 'dev-user',
        kind: 'knowledge_base',
        name: '客服话术知识库',
        description: '覆盖售前咨询、售后服务与高频问题的标准回复语料。',
      },
      {
        id: 'skill-order-lookup',
        organizationId: 'dev-org',
        ownerUserId: 'dev-user',
        kind: 'skill',
        name: '订单查询 Skill',
        description: '按订单号查询订单状态与物流进度，供客服 Agent 调用。',
      },
      {
        id: 'tool-logistics-query',
        organizationId: 'dev-org',
        ownerUserId: 'dev-user',
        kind: 'tool',
        name: '订单物流查询工具',
        description: '按订单号查询物流轨迹与预计送达时间，供客服 Agent 调用。',
      },
      {
        id: 'plugin-wecom-notify',
        organizationId: 'dev-org',
        ownerUserId: 'dev-user',
        kind: 'plugin',
        name: '企业微信通知插件',
        description: '将 Agent 的处理结果推送到企业微信群或单聊。',
      },
    ],
  };
  const store = options.store ?? (process.env.DATABASE_URL
    ? new PostgresStore(options.databaseOptions)
    : new MemoryStore({ ...options, seed: options.seed ?? devSeed }));
  const maxBodyBytes = options.maxBodyBytes ?? Number(process.env.BAIRUI_MAX_BODY_BYTES ?? 1024 * 1024);
  const auth = options.auth ?? new DevAuth(store, { ...options.authOptions, devUser: devSeed.users?.[0] });
  const runtime = options.runtime ?? new MockRuntime(options.runtimeOptions);

  const server = createServer(async (request, response) => {
    const requestId = getRequestId(request);
    response.setHeader('x-request-id', requestId);
    const url = new URL(request.url, 'http://platform.local');
    const path = url.pathname;
    const principal = await auth.resolve(request);
    const scope = principal && { userId: principal.userId, organizationId: principal.organizationId };

    try {
      if (request.method === 'GET' && path === '/healthz') {
        try {
          await store.ping?.();
          return sendJson(response, 200, { status: 'ok', database: process.env.DATABASE_URL ? 'postgres' : 'memory' });
        } catch (error) {
          console.error(error);
          return sendError(response, 503, 'database_unavailable', 'Database unavailable', requestId);
        }
      }

      if (request.method === 'POST' && path === '/api/auth/dev-login') {
        if (process.env.NODE_ENV === 'production') return sendError(response, 404, 'not_found', 'Not found', requestId);
        const input = await readJson(request, maxBodyBytes);
        const result = await auth.login(input.email, input.password);
        if (!result) return sendError(response, 401, 'invalid_credentials', 'Invalid email or password', requestId);
        return sendJson(response, 200, { user: result.user }, { 'set-cookie': auth.cookie(result.token) });
      }

      if (request.method === 'POST' && path === '/api/auth/logout') {
        await auth.clear(request);
        return sendJson(response, 200, { ok: true }, { 'set-cookie': auth.expiredCookie() });
      }

      if (request.method === 'GET' && path === '/api/auth/me') {
        return principal
          ? sendJson(response, 200, { user: principal })
          : sendError(response, 401, 'unauthenticated', 'Authentication required', requestId);
      }

      if (!principal) return sendError(response, 401, 'unauthenticated', 'Authentication required', requestId);

      if (request.method === 'GET' && path === '/api/user/resources') {
        const kind = url.searchParams.get('kind') || undefined;
        if (kind && !RESOURCE_KINDS.includes(kind)) {
          return sendError(response, 422, 'validation_error', 'Unsupported resource kind', requestId);
        }
        return sendJson(response, 200, { resources: await store.listResources(scope, kind) });
      }

      if (request.method === 'POST' && path === '/api/user/resources') {
        const input = await readJson(request, maxBodyBytes);
        if (!RESOURCE_KINDS.includes(input.kind)
          || typeof input.name !== 'string'
          || input.name.trim().length === 0) {
          return sendError(response, 422, 'validation_error', 'Resource kind and name are required', requestId);
        }
        if (input.description !== undefined && input.description !== null && typeof input.description !== 'string') {
          return sendError(response, 422, 'validation_error', 'Resource description must be a string', requestId);
        }
        if (input.config !== undefined && (typeof input.config !== 'object' || input.config === null || Array.isArray(input.config))) {
          return sendError(response, 422, 'validation_error', 'Resource config must be an object', requestId);
        }
        if (input.content !== undefined && input.content !== null && typeof input.content !== 'string') {
          return sendError(response, 422, 'validation_error', 'Resource content must be a string', requestId);
        }
        const resource = await store.createResource(scope, {
          kind: input.kind,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          config: input.config ?? {},
          content: input.content ?? undefined,
        });
        return sendJson(response, 201, { resource }, { location: '/api/user/resources/' + resource.id });
      }

      const resourceMatch = path.match(/^\/api\/user\/resources\/([^/]+)$/);
      if (resourceMatch && request.method === 'GET') {
        const resource = await store.findResource(scope, resourceMatch[1]);
        if (!resource) return sendError(response, 404, 'resource_not_found', 'Resource not found', requestId);
        const contentItems = await store.listResourceContents(scope, resource.id);
        return sendJson(response, 200, { resource, contentItems });
      }

      if (resourceMatch && request.method === 'PATCH') {
        const input = await readJson(request, maxBodyBytes);
        const update = {};
        if (input.name !== undefined) {
          if (typeof input.name !== 'string' || input.name.trim().length === 0) {
            return sendError(response, 422, 'validation_error', 'Resource name must not be blank', requestId);
          }
          update.name = input.name.trim();
        }
        if (input.description !== undefined) {
          if (input.description !== null && typeof input.description !== 'string') {
            return sendError(response, 422, 'validation_error', 'Resource description must be a string', requestId);
          }
          update.description = input.description?.trim() || null;
        }
        if (input.status !== undefined) {
          if (!['active', 'archived'].includes(input.status)) {
            return sendError(response, 422, 'validation_error', 'Unsupported resource status', requestId);
          }
          update.status = input.status;
        }
        if (input.config !== undefined) {
          if (typeof input.config !== 'object' || input.config === null || Array.isArray(input.config)) {
            return sendError(response, 422, 'validation_error', 'Resource config must be an object', requestId);
          }
          update.config = input.config;
        }
        let contentChanged = false;
        if (input.content !== undefined) {
          if (input.content !== null && typeof input.content !== 'string') {
            return sendError(response, 422, 'validation_error', 'Resource content must be a string', requestId);
          }
          contentChanged = true;
        }
        if (Object.keys(update).length === 0 && !contentChanged) {
          return sendError(response, 422, 'validation_error', 'No resource fields to update', requestId);
        }
        const resource = await store.updateResource(scope, resourceMatch[1], update);
        if (!resource) return sendError(response, 404, 'resource_not_found', 'Resource not found', requestId);
        if (contentChanged) await store.saveResourceContent(scope, resource.id, input.content ?? '');
        return sendJson(response, 200, { resource });
      }

      if (resourceMatch && request.method === 'DELETE') {
        const removed = await store.deleteResource(scope, resourceMatch[1]);
        if (!removed) return sendError(response, 404, 'resource_not_found', 'Resource not found', requestId);
        response.writeHead(204);
        response.end();
        return;
      }

      if (request.method === 'GET' && path === '/api/user/agents') {
        return sendJson(response, 200, { agents: await store.listAgents(scope) });
      }

      if (request.method === 'POST' && path === '/api/user/agents') {
        const input = await readJson(request, maxBodyBytes);
        if (typeof input.name !== 'string' || input.name.trim().length === 0) {
          return sendError(response, 422, 'validation_error', 'Agent name is required', requestId);
        }
        const idempotencyKey = request.headers['idempotency-key'];
        const bodyHash = requestHash(input);
        if (idempotencyKey) {
          const previous = await store.getIdempotency(scope, idempotencyKey);
          if (previous && previous.requestHash !== bodyHash) {
            return sendError(response, 409, 'idempotency_conflict', 'Idempotency key was used for a different request', requestId);
          }
          if (previous) return sendJson(response, previous.status, previous.body, { ...previous.headers, location: previous.headers?.location ?? '/api/user/agents/' + previous.body.agent.id });
        }
        const agent = await store.createAgent(scope, { name: input.name.trim() });
        const body = { agent: await store.findAgent(scope, agent.id) };
        const headers = { location: '/api/user/agents/' + agent.id };
        if (idempotencyKey) await store.setIdempotency(scope, idempotencyKey, { requestHash: bodyHash, status: 202, body, headers });
        if (!store.claimOutbox) setTimeout(async () => {
          try {
            const provisioned = await runtime.provision(agent);
            await store.markAgentReady(agent.id, provisioned.runtimeUrl);
          } catch (caught) { console.error(caught); }
        }, 0).unref?.();
        return sendJson(response, 202, body, headers);
      }

      const agentMatch = path.match(/^\/api\/user\/agents\/([^/]+)$/);
      if (request.method === 'GET' && agentMatch) {
        const agent = await store.findAgent(scope, agentMatch[1]);
        return agent
          ? sendJson(response, 200, { agent })
          : sendError(response, 404, 'agent_not_found', 'Agent not found', requestId);
      }

      const sessionMatch = path.match(/^\/api\/user\/agents\/([^/]+)\/sessions$/);
      if (request.method === 'POST' && sessionMatch) {
        const input = await readJson(request, maxBodyBytes);
        const agent = await store.findAgent(scope, sessionMatch[1]);
        if (!agent) return sendError(response, 404, 'agent_not_found', 'Agent not found', requestId);
        if (agent.status !== 'ready') return sendError(response, 409, 'agent_not_ready', 'Agent is not ready', requestId);
        const session = await store.createSession(scope, agent.id, typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined);
        if (!session) return sendError(response, 409, 'agent_not_ready', 'Agent is not ready', requestId);
        return sendJson(response, 201, { session }, { location: '/api/user/agents/' + agent.id + '/sessions/' + session.id });
      }

      const messagesMatch = path.match(/^\/api\/user\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/);
      if (request.method === 'GET' && messagesMatch) {
        const agent = await store.findAgent(scope, messagesMatch[1]);
        const session = await store.findSession(scope, messagesMatch[1], messagesMatch[2]);
        if (!agent) return sendError(response, 404, 'agent_not_found', 'Agent not found', requestId);
        if (!session) return sendError(response, 404, 'session_not_found', 'Session not found', requestId);
        const messages = await store.listMessages(scope, session.id);
        return sendJson(response, 200, { messages });
      }

      const streamMatch = path.match(/^\/api\/user\/agents\/([^/]+)\/sessions\/([^/]+)\/chat\/stream$/);
      if (request.method === 'POST' && streamMatch) {
        const input = await readJson(request, maxBodyBytes);
        if (typeof input.message !== 'string' || input.message.trim().length === 0) {
          return sendError(response, 422, 'validation_error', 'Message is required', requestId);
        }
        const agent = await store.findAgent(scope, streamMatch[1]);
        const session = await store.findSession(scope, streamMatch[1], streamMatch[2]);
        if (!agent) return sendError(response, 404, 'agent_not_found', 'Agent not found', requestId);
        if (!session) return sendError(response, 404, 'session_not_found', 'Session not found', requestId);
        if (agent.status !== 'ready') return sendError(response, 409, 'agent_not_ready', 'Agent is not ready', requestId);
        sendSseHeaders(response);
        try {
          await store.addMessage(scope, { sessionId: session.id, role: 'user', content: input.message.trim() });
          const assistantParts = [];
          const usage = await runtime.streamChat({
            agent,
            message: input.message.trim(),
            writeEvent: (event, data) => {
              if (event === 'message.completed' && data?.content) assistantParts.push(String(data.content));
              writeSse(response, event, { ...data, requestId });
            },
          });
          await store.addUsage(scope, usage.totalTokens, { agentId: agent.id, sessionId: session.id });
          if (assistantParts.length > 0) {
            await store.addMessage(scope, { sessionId: session.id, role: 'assistant', content: assistantParts.join('\n'), outputTokens: usage.totalTokens ?? 0 });
          }
        } catch (caught) {
          writeSse(response, 'run.failed', { code: 'runtime_error', requestId });
        } finally {
          response.end();
        }
        return;
      }

      if (request.method === 'GET' && path === '/api/user/usage') {
        const range = url.searchParams.get('range') || 'today';
        if (!['today', '7d', '30d'].includes(range)) return sendError(response, 422, 'validation_error', 'Unsupported usage range', requestId);
        const usage = await store.getUsage(scope, range);
        const agents = await store.listAgents(scope);
        return sendJson(response, 200, {
          range,
          updatedAt: new Date().toISOString(),
          summary: {
            totalCalls: usage.totalTokens > 0 ? 1 : 0,
            failedCalls: 0,
            successRate: usage.totalTokens > 0 ? 1 : 0,
            avgLatencyMs: 0,
            totalTokens: usage.totalTokens,
            estimatedCostUsd: 0,
            totalConversations: 0,
            activeAgents: agents.filter((agent) => agent.status === 'ready').length,
          },
          modelBreakdown: [],
          series: [],
        });
      }

      return sendError(response, 404, 'not_found', 'Not found', requestId);
    } catch (caught) {
      if (caught.message === 'invalid_json') return sendError(response, 400, 'invalid_json', 'Request body must be valid JSON', requestId);
      if (caught.message === 'payload_too_large') return sendError(response, 413, 'payload_too_large', 'Request body is too large', requestId);
      console.error(caught);
      return sendError(response, 500, 'internal_error', 'Internal server error', requestId);
    }
  });

  server.platform = { store, auth, runtime };
  return server;
}
