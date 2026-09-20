import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryStore } from './store.mjs';
import { PostgresStore } from './postgres-store.mjs';
import { createPrincipalResolver } from './auth/resolver.mjs';
import { createRuntimeResolver } from './runtime/engines/registry.mjs';
import { MemoryTaskStore, PostgresTaskStore, TaskError } from './scheduler/task-store.mjs';
import { platformCapabilities, validatePlatformStartup, disabledCapability } from './platform-config.mjs';
import { createReadiness } from './service-lifecycle.mjs';
import { createTelemetry, metricsConfiguration } from './observability/metrics.mjs';
import { routeLabel } from './observability/labels.mjs';
import { safeLog } from './observability/safe-log.mjs';
import { handleAdmin } from './admin/routes.mjs';
import { handleClientMonitoring } from './monitoring/client-routes.mjs';

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

function getRequestId() {
  return 'req_' + randomUUID();
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

// 口令登录处理：dev 替身与本地账号都实现了 login，因此两种模式共用同一入口。
async function handlePasswordLogin(auth, request, response, maxBodyBytes, requestId) {
  const input = await readJson(request, maxBodyBytes);
  const result = await auth.login(input.email, input.password);
  if (!result) return sendError(response, 401, 'invalid_credentials', 'Invalid email or password', requestId);
  return sendJson(response, 200, { user: result.user }, { 'set-cookie': auth.cookie(result.token) });
}

export const RESOURCE_KINDS = ['knowledge_base', 'skill', 'tool', 'plugin'];

// 模拟 Runtime 计费单价：每次 Agent 对话调用固定扣费 10 分（0.1 元）。
export const BILLING_CENTS_PER_CALL = 10;

// 注册入口的基础校验：邮箱形态与最小口令长度（仅拦截空/极弱口令，不做强度评分）。
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8;

export function createApp(options = {}) {
  const env = options.env ?? process.env;
  const capabilities = platformCapabilities(env);
  const injectedTest = env.NODE_ENV === 'test' && (options.store || options.auth || options.authOptions?.betterAuthDatabase);
  if (!injectedTest) validatePlatformStartup(env);
  const metricsConfig = metricsConfiguration(env);
  const devSeed = env.NODE_ENV === 'production' || env.BAIRUI_AUTH_MODE === 'better-auth' ? {} : {
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
  const store = options.store ?? (env.DATABASE_URL
    ? new PostgresStore({ connectionString: env.DATABASE_URL, ...options.databaseOptions })
    : new MemoryStore({ ...options, seed: options.seed ?? devSeed }));
  const maxBodyBytes = options.maxBodyBytes ?? Number(env.BAIRUI_MAX_BODY_BYTES ?? 1024 * 1024);
  // 身份解析统一走 PrincipalResolver 工厂（docs/30 §4.1）：开发期是受限替身，
  // 接入正式身份提供方时只替换工厂实现，路由与业务代码不变。
  const auth = options.auth ?? createPrincipalResolver(store, {
    env: options.env ?? process.env,
    ...options.authOptions,
    devUser: devSeed.users?.[0],
  });
  if (capabilities.mode === 'platform' && !injectedTest && (!(store instanceof PostgresStore) || auth.provider !== 'better-auth')) {
    throw new Error('Platform mode requires PostgreSQL and Better Auth');
  }
  const runtimeResolver = capabilities.agentExecution ? createRuntimeResolver({ env, runtimeOptions: options.runtimeOptions }) : null;
  // 全局 fallback runtime（options.runtime 注入用于测试与旧调用路径）。
  const runtime = capabilities.agentExecution ? (options.runtime ?? runtimeResolver.resolve(options.engineKind ?? 'mock').runtime) : null;
  // 真实对话与后台 provisioning 按 agent.engine 动态解析对应引擎运行时。
  const getRuntimeFor = (agent) => {
    if (!capabilities.agentExecution) throw new Error('agent_runtime_disabled');
    return options.runtime ?? runtimeResolver.resolve(agent?.engine ?? 'mock').runtime;
  };
  const simulationEnabled = env.BAIRUI_SIMULATION_ENABLED === '1' && env.NODE_ENV !== 'production';
  if (simulationEnabled && !env.BETTER_AUTH_URL) throw new Error('Simulation API requires BETTER_AUTH_URL');
  const simulationUsers = new Set((env.BAIRUI_SIMULATION_USERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const tasks = simulationEnabled ? (options.taskStore ?? (store instanceof PostgresStore ? new PostgresTaskStore(store.pool) : new MemoryTaskStore())) : null;
  const ready = createReadiness(store, options.readinessTimeoutMs ?? 2000);
  const telemetry = createTelemetry(metricsConfig, store, { readinessTimeoutMs: options.metricsReadinessTimeoutMs });
  let draining = false;

  const server = createServer(async (request, response) => {
    telemetry.observeRequest(request, response);
    const requestId = getRequestId();
    response.setHeader('x-request-id', requestId);
    try {
      const url = new URL(request.url, 'http://platform.local');
      const path = url.pathname;
      if (path.startsWith('/api/admin/') || path.startsWith('/api/user/monitoring/')) response.setHeader('cache-control', 'no-store');
      if (request.method === 'GET' && ['/livez', '/readyz', '/healthz'].includes(path)) {
        response.setHeader('cache-control', 'no-store');
        if (path === '/livez') return sendJson(response, 200, { status: 'ok' });
        if (draining) return sendError(response, 503, 'service_draining', 'Service draining', requestId);
        if (!await ready() || draining) return sendError(response, 503, 'database_unavailable', 'Database unavailable', requestId);
        return sendJson(response, 200, { status: 'ok', database: store instanceof PostgresStore ? 'postgres' : 'memory' });
      }
      if (draining) {
        response.setHeader('cache-control', 'no-store');
        response.setHeader('retry-after', '1');
        return sendError(response, 503, 'service_draining', 'Service draining', requestId);
      }
      if (request.method === 'GET' && path === '/api/auth/config') {
        return sendJson(response, 200, { provider: auth.provider ?? 'local', capabilities }, { 'cache-control': 'no-store' });
      }
      if (auth.handle && path.startsWith('/api/auth/') && path !== '/api/auth/me') {
        return await auth.handle(request, response, path, maxBodyBytes);
      }
      const principal = await auth.resolve(request);
      const scope = principal && { userId: principal.userId, organizationId: principal.organizationId };

      // 注册：创建个人组织与账号并直接签发会话。生产环境同样可用，
      // 是 local 身份模式下的主入口（dev-login 仅在非生产环境开放）。
      if (request.method === 'POST' && path === '/api/auth/register') {
        if (typeof auth.register !== 'function') {
          return sendError(response, 404, 'not_found', 'Not found', requestId);
        }
        const input = await readJson(request, maxBodyBytes);
        const email = typeof input.email === 'string' ? input.email.trim() : '';
        const password = typeof input.password === 'string' ? input.password : '';
        if (!EMAIL_PATTERN.test(email)) {
          return sendError(response, 422, 'validation_error', 'A valid email is required', requestId);
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
          return sendError(response, 422, 'validation_error', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`, requestId);
        }
        if (input.displayName !== undefined && input.displayName !== null && typeof input.displayName !== 'string') {
          return sendError(response, 422, 'validation_error', 'Display name must be a string', requestId);
        }
        const result = await auth.register({
          email,
          password,
          displayName: typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : null,
        });
        if (!result) return sendError(response, 409, 'email_taken', 'Email is already registered', requestId);
        return sendJson(response, 201, { user: result.user }, { 'set-cookie': auth.cookie(result.token) });
      }

      // 规范登录端点：所有身份模式共用，生产环境同样开放。
      if (request.method === 'POST' && path === '/api/auth/login') {
        return handlePasswordLogin(auth, request, response, maxBodyBytes, requestId);
      }

      // 兼容别名：仅非生产环境开放，历史上是本地开发的唯一登录入口。
      if (request.method === 'POST' && path === '/api/auth/dev-login') {
        if (env.NODE_ENV === 'production') return sendError(response, 404, 'not_found', 'Not found', requestId);
        return handlePasswordLogin(auth, request, response, maxBodyBytes, requestId);
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

      if (path.startsWith('/api/admin/')) {
        return await handleAdmin({ request, response, url, principal, store,
          enabled: capabilities.mode === 'platform' && auth.provider === 'better-auth', sendJson, sendError, requestId });
      }
      if (!principal) return sendError(response, 401, 'unauthenticated', 'Authentication required', requestId);

      if (path.startsWith('/api/user/monitoring/')) {
        return await handleClientMonitoring({ request, response, url, scope, store, sendJson, sendError, requestId });
      }

      const disabled = disabledCapability(capabilities, request.method, path);
      if (disabled) return sendError(response, 403, 'capability_disabled', 'Capability unavailable: ' + disabled, requestId);

      if (path === '/api/simulation/tasks' || path.startsWith('/api/simulation/tasks/')) {
        if (!tasks || !simulationUsers.has(principal.email?.toLowerCase())) return sendError(response, 404, 'not_found', 'Not found', requestId);
        if (request.method !== 'GET' && request.headers.origin !== env.BETTER_AUTH_URL) return sendError(response, 403, 'origin_rejected', 'Origin rejected', requestId);
        if (path === '/api/simulation/tasks') {
          if (request.method === 'GET') return sendJson(response, 200, { tasks: await tasks.list(scope) });
          if (request.method === 'POST') {
            const input = await readJson(request, 4096);
            if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !['durationMs', 'outcome'].includes(key))) throw new TaskError('invalid_task');
            return sendJson(response, 201, { task: await tasks.submit(scope, request.headers['idempotency-key'], input) });
          }
        }
        const match = path.match(/^\/api\/simulation\/tasks\/([a-zA-Z0-9-]+)(\/cancel)?$/);
        if (match && ((request.method === 'GET' && !match[2]) || (request.method === 'POST' && match[2]))) {
          const task = match[2] ? await tasks.cancel(scope, match[1]) : await tasks.get(scope, match[1]);
          return task ? sendJson(response, 200, { task }) : sendError(response, 404, 'not_found', 'Not found', requestId);
        }
        return sendError(response, 404, 'not_found', 'Not found', requestId);
      }

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
        const engine = input.engine === undefined ? 'mock' : String(input.engine);
        if (!['mock', 'pi', 'dsh'].includes(engine)) {
          return sendError(response, 422, 'validation_error', 'Unsupported engine', requestId);
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
        const agent = await store.createAgent(scope, { name: input.name.trim(), engine });
        const body = { agent: await store.findAgent(scope, agent.id) };
        const headers = { location: '/api/user/agents/' + agent.id };
        if (idempotencyKey) await store.setIdempotency(scope, idempotencyKey, { requestHash: bodyHash, status: 202, body, headers });
        if (!store.claimOutbox) setTimeout(async () => {
          try {
            const provisioned = await getRuntimeFor(agent).provision(agent);
            await store.markAgentReady(agent.id, provisioned.runtimeUrl);
          } catch {
            safeLog('runtime_provision_error', { requestId, method: request.method, route: routeLabel(request.url) });
          }
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
          const usage = await getRuntimeFor(agent).streamChat({
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
            const chargeLabel = agent.engine && agent.engine !== 'mock' ? `${agent.engine} 引擎` : '模拟 Runtime';
            await store.chargeForUsage(scope, { agentId: agent.id, sessionId: session.id, amountCents: BILLING_CENTS_PER_CALL, description: `Agent 对话调用 ×1（${chargeLabel}，0.1 元/次）` });
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

      // ---------- 我的收藏 ----------
      if (request.method === 'GET' && path === '/api/user/favorites') {
        return sendJson(response, 200, { favorites: await store.listFavorites(scope) });
      }

      if (request.method === 'POST' && path === '/api/user/favorites') {
        const input = await readJson(request, maxBodyBytes);
        if (!['agent', 'resource'].includes(input.targetType) || typeof input.targetId !== 'string' || !input.targetId.trim()) {
          return sendError(response, 422, 'validation_error', 'Favorite target type and id are required', requestId);
        }
        const favorite = await store.addFavorite(scope, input.targetType, input.targetId.trim());
        if (!favorite) return sendError(response, 404, 'favorite_target_not_found', 'Favorite target not found', requestId);
        return sendJson(response, 201, { favorite }, { location: '/api/user/favorites/' + favorite.id });
      }

      const favoriteMatch = path.match(/^\/api\/user\/favorites\/([^/]+)$/);
      if (request.method === 'DELETE' && favoriteMatch) {
        const removed = await store.removeFavorite(scope, favoriteMatch[1]);
        if (!removed) return sendError(response, 404, 'favorite_not_found', 'Favorite not found', requestId);
        response.writeHead(204);
        response.end();
        return;
      }

      // ---------- 站内通知 ----------
      if (request.method === 'GET' && path === '/api/user/notifications') {
        const result = await store.listNotifications(scope);
        return sendJson(response, 200, { notifications: result.notifications, unreadCount: result.unreadCount });
      }

      if (request.method === 'POST' && path === '/api/user/notifications/read-all') {
        const updated = await store.markNotificationsRead(scope);
        return sendJson(response, 200, { ok: true, updated });
      }

      const notificationMatch = path.match(/^\/api\/user\/notifications\/([^/]+)$/);
      if (request.method === 'PATCH' && notificationMatch) {
        const updated = await store.markNotificationsRead(scope, notificationMatch[1]);
        if (updated === 0) return sendError(response, 404, 'notification_not_found', 'Notification not found', requestId);
        return sendJson(response, 200, { ok: true, updated });
      }

      // ---------- 用户设置 ----------
      if (request.method === 'GET' && path === '/api/user/settings') {
        return sendJson(response, 200, { settings: await store.getSettings(scope) });
      }

      if (request.method === 'PATCH' && path === '/api/user/settings') {
        const input = await readJson(request, maxBodyBytes);
        const update = {};
        if (input.displayName !== undefined) {
          if (input.displayName !== null && typeof input.displayName !== 'string') {
            return sendError(response, 422, 'validation_error', 'Display name must be a string', requestId);
          }
          update.displayName = typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : null;
        }
        if (input.prefs !== undefined) {
          if (typeof input.prefs !== 'object' || input.prefs === null || Array.isArray(input.prefs)) {
            return sendError(response, 422, 'validation_error', 'Prefs must be an object', requestId);
          }
          update.prefs = input.prefs;
        }
        if (Object.keys(update).length === 0) {
          return sendError(response, 422, 'validation_error', 'No settings fields to update', requestId);
        }
        return sendJson(response, 200, { settings: await store.updateSettings(scope, update) });
      }

      // ---------- 费用中心 ----------
      if (request.method === 'GET' && path === '/api/user/account') {
        return sendJson(response, 200, { account: await store.getAccount(scope) });
      }

      if (request.method === 'GET' && path === '/api/user/billing/transactions') {
        return sendJson(response, 200, { transactions: await store.listTransactions(scope) });
      }

      if (request.method === 'POST' && path === '/api/user/billing/recharge') {
        const input = await readJson(request, maxBodyBytes);
        if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > 100_000_000) {
          return sendError(response, 422, 'validation_error', 'Recharge amount must be a positive amount in cents', requestId);
        }
        if (input.remark !== undefined && typeof input.remark !== 'string') {
          return sendError(response, 422, 'validation_error', 'Remark must be a string', requestId);
        }
        const transaction = await store.recharge(scope, { amountCents: input.amountCents, description: input.remark?.trim() || '账户充值' });
        const account = await store.getAccount(scope);
        return sendJson(response, 201, { transaction, account }, { location: '/api/user/billing/transactions/' + transaction.id });
      }

      // ---------- 备案 ----------
      if (request.method === 'GET' && path === '/api/user/filings') {
        return sendJson(response, 200, { filings: await store.listFilings(scope) });
      }

      if (request.method === 'POST' && path === '/api/user/filings') {
        const input = await readJson(request, maxBodyBytes);
        const domain = typeof input.domain === 'string' ? input.domain.trim() : '';
        const subjectName = typeof input.subjectName === 'string' ? input.subjectName.trim() : '';
        if (!domain || !subjectName || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(domain)) {
          return sendError(response, 422, 'validation_error', 'Filing domain and subject name are required with a valid domain', requestId);
        }
        if (input.subjectType !== undefined && !['enterprise', 'individual'].includes(input.subjectType)) {
          return sendError(response, 422, 'validation_error', 'Unsupported subject type', requestId);
        }
        if (input.icpNumber !== undefined && input.icpNumber !== null && typeof input.icpNumber !== 'string') {
          return sendError(response, 422, 'validation_error', 'ICP number must be a string', requestId);
        }
        const filing = await store.createFiling(scope, {
          domain,
          subjectName,
          subjectType: input.subjectType ?? 'enterprise',
          icpNumber: typeof input.icpNumber === 'string' && input.icpNumber.trim() ? input.icpNumber.trim() : null,
        });
        return sendJson(response, 201, { filing }, { location: '/api/user/filings/' + filing.id });
      }

      return sendError(response, 404, 'not_found', 'Not found', requestId);
    } catch (caught) {
      if (caught.message === 'invalid_client_ip') return sendError(response, 400, 'invalid_client_ip', 'Invalid client address', requestId);
      if (caught instanceof TaskError) return sendError(response, caught.code === 'queue_full' ? 429 : caught.code === 'idempotency_conflict' ? 409 : 422, caught.code, caught.code, requestId);
      if (caught.message === 'identity_link_required') return sendError(response, 409, 'identity_link_required', 'Account migration requires verified identity linking', requestId);
      if (caught.message === 'invalid_json') return sendError(response, 400, 'invalid_json', 'Request body must be valid JSON', requestId);
      if (caught.message === 'payload_too_large') return sendError(response, 413, 'payload_too_large', 'Request body is too large', requestId);
      safeLog('http_request_error', { requestId, method: request.method, route: routeLabel(request.url), status: 500 });
      return sendError(response, 500, 'internal_error', 'Internal server error', requestId);
    }
  });

  server.once('close', () => { void telemetry.close(); });
  server.platform = { store, auth, runtime, capabilities, telemetry, beginShutdown() {
    draining = true;
    void telemetry.close();
  } };
  return server;
}
