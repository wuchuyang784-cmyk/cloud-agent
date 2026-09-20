import { randomUUID } from 'node:crypto';
import { agentHost } from './agent-host.mjs';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class MemoryStore {
  constructor(options = {}) {
    const seed = options.seed ?? {};
    this.users = new Map((seed.users ?? []).map((user) => [user.id, { ...user }]));
    // 组织与成员关系：内存实现同样维护，保证与 Postgres 分支行为一致，
    // 并为多组织能力提供统一的读取入口（listUserOrganizations）。
    this.organizations = new Map();
    this.memberships = new Map();
    this.agentMemberships = new Map();
    for (const user of seed.users ?? []) {
      if (!user.organizationId) continue;
      const seededAt = new Date().toISOString();
      this.organizations.set(user.organizationId, {
        id: user.organizationId,
        name: user.organizationName ?? user.organizationId,
        kind: user.organizationKind ?? 'personal',
        createdAt: seededAt,
      });
      this.memberships.set(user.organizationId + ':' + user.id, {
        organizationId: user.organizationId,
        userId: user.id,
        role: user.role ?? 'user',
        createdAt: seededAt,
      });
    }
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
    this.usageEvents = clone(seed.usageEvents ?? []);
    this.runtimeRoutes = new Map((seed.runtimeRoutes ?? []).map(row => [row.agentId, clone(row)]));
    this.outbox = [];
    this.idempotency = new Map();
    this.authSessions = new Map();
    this.favorites = new Map();
    this.notifications = new Map();
    this.settings = new Map();
    this.accounts = new Map();
    this.transactions = new Map();
    this.filings = new Map();
  }

  findUserByEmail(email) {
    return clone([...this.users.values()].find((user) => user.email.toLowerCase() === email.toLowerCase()));
  }

  findUser(userId) {
    return clone(this.users.get(userId));
  }

  ensureIdentityUser(input) {
    if (!input.subject || !input.email) throw new Error('invalid_identity');
    const existing = [...this.users.values()].find(user => user.authSubject === input.subject);
    if (existing) return clone(existing);
    if (this.findUserByEmail(input.email)) throw new Error('identity_link_required');
    const user = this.createUserWithOrganization({ email: input.email, displayName: input.displayName });
    this.users.get(user.id).authSubject = input.subject;
    return this.findUser(user.id);
  }

  // 注册：原子创建个人组织、用户与组织成员关系。邮箱已存在返回 null。
  // 个人组织是真实组织，未来升级为团队时只需追加成员，无需迁移业务数据。
  createUserWithOrganization(input) {
    const email = String(input.email ?? '').trim().toLowerCase();
    if (!email || this.findUserByEmail(email)) return null;
    const now = new Date().toISOString();
    const organizationId = input.organizationId ?? 'org-' + randomUUID();
    const userId = input.userId ?? 'user-' + randomUUID();
    this.organizations.set(organizationId, {
      id: organizationId,
      name: input.organizationName ?? email,
      kind: 'personal',
      createdAt: now,
    });
    this.users.set(userId, {
      id: userId,
      email,
      displayName: input.displayName ?? null,
      passwordHash: input.passwordHash,
      organizationId,
      role: 'org_admin',
    });
    this.memberships.set(organizationId + ':' + userId, {
      organizationId,
      userId,
      role: 'org_admin',
      createdAt: now,
    });
    return this.findUser(userId);
  }

  // 返回用户所属的全部组织（多组织预留：当前长度为 1）。
  listUserOrganizations(userId) {
    return clone([...this.memberships.values()]
      .filter((membership) => membership.userId === userId)
      .map((membership) => {
        const organization = this.organizations.get(membership.organizationId);
        return {
          id: membership.organizationId,
          name: organization?.name ?? membership.organizationId,
          kind: organization?.kind ?? 'personal',
          role: membership.role,
        };
      }));
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
      engine: input.engine ?? 'mock',
      templateId: input.templateId ?? null,
      templateVersion: input.templateVersion ?? null,
      status: 'provisioning',
      runtimeUrl: null,
      host: agentHost(input.id ?? 'pending'),
      createdAt: now,
      updatedAt: now,
    };
    agent.host = agentHost(agent.id);
    this.agents.set(agent.id, agent);
    // 同步写入 Agent 成员关系：个人租户阶段只有 owner 一行，
    // 未来组织内协作时按 role（owner/operator/viewer）扩展授权。
    this.agentMemberships.set(agent.id + ':' + scope.userId, {
      organizationId: scope.organizationId,
      agentId: agent.id,
      userId: scope.userId,
      role: 'owner',
      createdAt: now,
    });
    this.outbox.push({ id: randomUUID(), type: 'agent.provision', aggregateId: agent.id, status: 'pending', createdAt: now });
    return clone(this.#viewAgent(agent));
  }

  markAgentReady(agentId, runtimeUrl) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    agent.status = 'ready';
    agent.runtimeUrl = runtimeUrl;
    agent.updatedAt = new Date().toISOString();
    this.runtimeRoutes.set(agentId, { agentId, organizationId: agent.organizationId,
      healthStatus: 'healthy', lastSeenAt: agent.updatedAt });
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

  addUsage(scope, amount = 0, context = {}) {
    const key = scope.organizationId + ':' + scope.userId;
    this.usage.set(key, (this.usage.get(key) ?? 0) + amount);
    if (context.agentId) this.usageEvents.push({ organizationId: scope.organizationId, userId: scope.userId,
      agentId: context.agentId, calls: 1, failedCalls: 0, inputTokens: 0, outputTokens: amount,
      latencyMs: null, occurredAt: new Date().toISOString() });
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

  // ---------- 我的收藏 ----------
  listFavorites(scope) {
    return clone([...this.favorites.values()]
      .filter((favorite) => favorite.organizationId === scope.organizationId && favorite.userId === scope.userId)
      .map((favorite) => {
        const target = favorite.targetType === 'agent'
          ? this.agents.get(favorite.targetId)
          : this.resources.get(favorite.targetId);
        if (!target || target.organizationId !== scope.organizationId
          || (favorite.targetType === 'agent' ? target.ownerUserId : target.ownerUserId) !== scope.userId) return null;
        return {
          id: favorite.id,
          targetType: favorite.targetType,
          targetId: favorite.targetId,
          name: target.name,
          status: target.status,
          createdAt: favorite.createdAt,
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)));
  }

  addFavorite(scope, targetType, targetId) {
    const target = targetType === 'agent'
      ? this.agents.get(targetId)
      : this.resources.get(targetId);
    if (!target || target.organizationId !== scope.organizationId
      || (targetType === 'agent' ? target.ownerUserId : target.ownerUserId) !== scope.userId) return null;
    const existing = [...this.favorites.values()].find((favorite) =>
      favorite.organizationId === scope.organizationId && favorite.userId === scope.userId
      && favorite.targetType === targetType && favorite.targetId === targetId);
    const favorite = existing ?? {
      id: 'fav-' + randomUUID(),
      organizationId: scope.organizationId,
      userId: scope.userId,
      targetType,
      targetId,
      createdAt: new Date().toISOString(),
    };
    if (!existing) this.favorites.set(favorite.id, favorite);
    return clone({ ...favorite, name: target.name, status: target.status });
  }

  removeFavorite(scope, favoriteId) {
    const favorite = this.favorites.get(favoriteId);
    if (!favorite || favorite.organizationId !== scope.organizationId || favorite.userId !== scope.userId) return false;
    this.favorites.delete(favoriteId);
    return true;
  }

  // ---------- 通知 ----------
  addNotification(scope, input = {}) {
    const notification = {
      id: 'notify-' + randomUUID(),
      organizationId: scope.organizationId,
      userId: scope.userId,
      type: input.type ?? 'system',
      title: input.title ?? '通知',
      body: input.body ?? '',
      isRead: false,
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    this.notifications.set(notification.id, notification);
    return clone(notification);
  }

  listNotifications(scope) {
    const all = [...this.notifications.values()]
      .filter((notification) => notification.organizationId === scope.organizationId && notification.userId === scope.userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return {
      notifications: clone(all.slice(0, 50)),
      unreadCount: all.filter((notification) => !notification.isRead).length,
    };
  }

  markNotificationsRead(scope, notificationId = null) {
    let updated = 0;
    for (const notification of this.notifications.values()) {
      if (notification.organizationId !== scope.organizationId || notification.userId !== scope.userId) continue;
      if (notificationId && notification.id !== notificationId) continue;
      if (!notification.isRead) { notification.isRead = true; notification.readAt = new Date().toISOString(); updated += 1; }
    }
    return updated;
  }

  // ---------- 设置 ----------
  #settingsKey(scope) {
    return scope.organizationId + ':' + scope.userId;
  }

  getSettings(scope) {
    const key = this.#settingsKey(scope);
    let settings = this.settings.get(key);
    if (!settings) {
      settings = { organizationId: scope.organizationId, userId: scope.userId, displayName: null, prefs: {}, updatedAt: new Date().toISOString() };
      this.settings.set(key, settings);
    }
    return clone(settings);
  }

  updateSettings(scope, input = {}) {
    const key = this.#settingsKey(scope);
    const settings = this.getSettings(scope);
    if (input.displayName !== undefined) settings.displayName = typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : null;
    if (input.prefs !== undefined) settings.prefs = { ...settings.prefs, ...(input.prefs ?? {}) };
    settings.updatedAt = new Date().toISOString();
    this.settings.set(key, settings);
    return clone(settings);
  }

  // ---------- 费用中心 ----------
  #accountKey(scope) {
    return scope.organizationId + ':' + scope.userId;
  }

  getAccount(scope) {
    const key = this.#accountKey(scope);
    let account = this.accounts.get(key);
    if (!account) {
      account = { organizationId: scope.organizationId, userId: scope.userId, balanceCents: 0, currency: 'CNY', updatedAt: new Date().toISOString() };
      this.accounts.set(key, account);
    }
    return clone(account);
  }

  listTransactions(scope, limit = 100) {
    return clone([...this.transactions.values()]
      .filter((transaction) => transaction.organizationId === scope.organizationId && transaction.userId === scope.userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
      .slice(0, limit));
  }

  recharge(scope, input = {}) {
    const key = this.#accountKey(scope);
    const account = this.getAccount(scope);
    const now = new Date().toISOString();
    const transaction = {
      id: 'tx-' + randomUUID(),
      organizationId: scope.organizationId,
      userId: scope.userId,
      type: 'recharge',
      amountCents: input.amountCents,
      balanceAfterCents: account.balanceCents + input.amountCents,
      referenceType: null,
      referenceId: null,
      description: input.description ?? '账户充值',
      createdAt: now,
    };
    account.balanceCents = transaction.balanceAfterCents;
    account.updatedAt = now;
    this.accounts.set(key, account);
    this.transactions.set(transaction.id, transaction);
    this.addNotification(scope, { type: 'billing', title: '充值成功', body: '账户到账 ' + formatCents(input.amountCents) + '，当前余额 ' + formatCents(transaction.balanceAfterCents) + '。' });
    return clone(transaction);
  }

  chargeForUsage(scope, input = {}) {
    const key = this.#accountKey(scope);
    const account = this.getAccount(scope);
    const now = new Date().toISOString();
    account.balanceCents -= input.amountCents;
    account.updatedAt = now;
    this.accounts.set(key, account);
    const transaction = {
      id: 'tx-' + randomUUID(),
      organizationId: scope.organizationId,
      userId: scope.userId,
      type: 'consume',
      amountCents: input.amountCents,
      balanceAfterCents: account.balanceCents,
      referenceType: input.agentId ? 'agent' : null,
      referenceId: input.agentId ?? null,
      description: input.description ?? 'Agent 调用扣费',
      createdAt: now,
    };
    this.transactions.set(transaction.id, transaction);
    if (account.balanceCents < 0) {
      this.addNotification(scope, { type: 'billing', title: '账户余额不足', body: '扣费后余额为 ' + formatCents(account.balanceCents) + '，请及时充值以免影响 Agent 服务。' });
    }
    return clone(transaction);
  }

  // ---------- 备案 ----------
  listFilings(scope) {
    return clone([...this.filings.values()]
      .filter((filing) => filing.organizationId === scope.organizationId && filing.ownerUserId === scope.userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)));
  }

  createFiling(scope, input = {}) {
    const now = new Date().toISOString();
    const filing = {
      id: 'filing-' + randomUUID(),
      organizationId: scope.organizationId,
      ownerUserId: scope.userId,
      domain: input.domain,
      subjectName: input.subjectName,
      subjectType: input.subjectType ?? 'enterprise',
      icpNumber: input.icpNumber ?? null,
      status: 'submitted',
      remark: null,
      createdAt: now,
      updatedAt: now,
    };
    this.filings.set(filing.id, filing);
    this.addNotification(scope, { type: 'system', title: '备案提交成功', body: '域名「' + input.domain + '」的备案申请已提交，状态为审核中。' });
    return clone(filing);
  }
}

function formatCents(cents) {
  return (cents / 100).toFixed(2) + ' 元';
}
