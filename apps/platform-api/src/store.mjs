import { randomUUID } from 'node:crypto';
import { agentHost } from './agent-host.mjs';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class MemoryStore {
  constructor(options = {}) {
    const seed = options.seed ?? {};
    this.users = new Map((seed.users ?? []).map((user) => [user.id, { ...user }]));
    this.agents = new Map((seed.agents ?? []).map((agent) => [agent.id, {
      status: 'provisioning',
      createdAt: new Date().toISOString(),
      ...agent,
    }]));
    this.resources = new Map();
    this.resourceContents = new Map();
    for (const resource of seed.resources ?? []) {
      const { content, ...rest } = resource;
      this.resources.set(resource.id, {
        status: 'active',
        description: null,
        config: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...rest,
      });
      if (typeof content === 'string' && content.trim()) {
        this.resourceContents.set(resource.id, [{ id: 'content-' + randomUUID(), kind: 'text', content, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
      }
    }
    this.sessions = new Map();
    this.messages = new Map();
    this.usage = new Map();
    this.outbox = [];
    this.idempotency = new Map();
    this.authSessions = new Map();
  }

  findUserByEmail(email) {
    return clone([...this.users.values()].find((user) => user.email.toLowerCase() === email.toLowerCase()));
  }

  findUser(userId) {
    return clone(this.users.get(userId));
  }

  listAgents(scope) {
    return clone([...this.agents.values()]
      .filter((agent) => agent.organizationId === scope.organizationId && agent.ownerUserId === scope.userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((agent) => this.#viewAgent(agent)));
  }

  findAgent(scope, agentId) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.organizationId !== scope.organizationId || agent.ownerUserId !== scope.userId) return null;
    return clone(this.#viewAgent(agent));
  }

  listResources(scope, kind) {
    return clone([...this.resources.values()]
      .filter((resource) => resource.organizationId === scope.organizationId
        && resource.ownerUserId === scope.userId
        && (!kind || resource.kind === kind))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)));
  }

  findResource(scope, resourceId) {
    const resource = this.resources.get(resourceId);
    if (!resource || resource.organizationId !== scope.organizationId || resource.ownerUserId !== scope.userId) return null;
    return clone(resource);
  }

  createResource(scope, input) {
    const now = new Date().toISOString();
    const resource = {
      id: input.id ?? 'resource-' + randomUUID(),
      organizationId: scope.organizationId,
      ownerUserId: scope.userId,
      kind: input.kind,
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? 'active',
      config: input.config ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.resources.set(resource.id, resource);
    if (typeof input.content === 'string' && input.content.trim()) {
      const now2 = new Date().toISOString();
      this.resourceContents.set(resource.id, [{ id: 'content-' + randomUUID(), kind: 'text', content: input.content, createdAt: now2, updatedAt: now2 }]);
    }
    return clone(resource);
  }

  updateResource(scope, resourceId, input) {
    const resource = this.resources.get(resourceId);
    if (!resource || resource.organizationId !== scope.organizationId || resource.ownerUserId !== scope.userId) return null;
    Object.assign(resource, input, { updatedAt: new Date().toISOString() });
    return clone(resource);
  }

  deleteResource(scope, resourceId) {
    const resource = this.resources.get(resourceId);
    if (!resource || resource.organizationId !== scope.organizationId || resource.ownerUserId !== scope.userId) return false;
    this.resources.delete(resourceId);
    this.resourceContents.delete(resourceId);
    return true;
  }

  listResourceContents(scope, resourceId) {
    const resource = this.resources.get(resourceId);
    if (!resource || resource.organizationId !== scope.organizationId || resource.ownerUserId !== scope.userId) return [];
    return clone(this.resourceContents.get(resourceId) ?? []);
  }

  saveResourceContent(scope, resourceId, content) {
    const resource = this.resources.get(resourceId);
    if (!resource || resource.organizationId !== scope.organizationId || resource.ownerUserId !== scope.userId) return null;
    const items = (typeof content === 'string' && content.trim())
      ? [{ id: 'content-' + randomUUID(), kind: 'text', content, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
      : [];
    this.resourceContents.set(resourceId, items);
    return clone(items);
  }

  createAgent(scope, input = {}) {
    const now = new Date().toISOString();
    const agent = {
      id: input.id ?? ('agent-' + randomUUID()),
      organizationId: scope.organizationId,
      ownerUserId: scope.userId,
      name: input.name ?? 'New agent',
      status: 'provisioning',
      runtimeUrl: null,
      host: agentHost(input.id ?? 'pending'),
      createdAt: now,
      updatedAt: now,
    };
    agent.host = agentHost(agent.id);
    this.agents.set(agent.id, agent);
    this.outbox.push({ id: randomUUID(), type: 'agent.provision', aggregateId: agent.id, status: 'pending', createdAt: now });
    return clone(this.#viewAgent(agent));
  }

  markAgentReady(agentId, runtimeUrl) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    agent.status = 'ready';
    agent.runtimeUrl = runtimeUrl;
    agent.updatedAt = new Date().toISOString();
    return clone(agent);
  }

  createSession(scope, agentId, title = 'New conversation') {
    const agent = this.findAgent(scope, agentId);
    if (!agent || agent.status !== 'ready') return null;
    const now = new Date().toISOString();
    const session = {
      id: 'session-' + randomUUID(),
      agentId,
      organizationId: scope.organizationId,
      userId: scope.userId,
      title,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return clone(session);
  }

  findSession(scope, agentId, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.agentId !== agentId || session.organizationId !== scope.organizationId || session.userId !== scope.userId) return null;
    return clone(session);
  }

  addMessage(scope, input) {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.organizationId !== scope.organizationId || session.userId !== scope.userId) return null;
    const now = new Date().toISOString();
    const message = {
      id: input.id ?? 'msg-' + randomUUID(),
      organizationId: session.organizationId,
      userId: session.userId,
      agentId: session.agentId,
      sessionId: session.id,
      role: input.role,
      content: input.content,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      createdAt: now,
    };
    this.messages.set(message.id, message);
    return clone(message);
  }

  listMessages(scope, sessionId) {
    return clone([...this.messages.values()]
      .filter((message) => message.sessionId === sessionId
        && message.organizationId === scope.organizationId
        && message.userId === scope.userId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
  }

  addUsage(scope, amount = 0) {
    const key = scope.organizationId + ':' + scope.userId;
    this.usage.set(key, (this.usage.get(key) ?? 0) + amount);
  }

  getUsage(scope) {
    return { range: 'today', totalTokens: this.usage.get(scope.organizationId + ':' + scope.userId) ?? 0 };
  }

  getIdempotency(scope, key) {
    return this.idempotency.get(scope.organizationId + ':' + scope.userId + ':' + key);
  }

  setIdempotency(scope, key, value) {
    this.idempotency.set(scope.organizationId + ':' + scope.userId + ':' + key, clone(value));
  }

  createAuthSession(id, userId, expiresAt) {
    const sessionId = id ?? 'memory-session-' + randomUUID();
    this.authSessions.set(sessionId, { id: sessionId, userId, expiresAt });
    return sessionId;
  }

  findAuthSession(id) {
    return clone(this.authSessions.get(id));
  }

  deleteAuthSession(id) {
    this.authSessions.delete(id);
  }

  #viewAgent(agent) {
    return { ...agent, host: agentHost(agent.id) };
  }
}
