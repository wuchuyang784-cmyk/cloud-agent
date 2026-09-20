import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { agentHost } from './agent-host.mjs';
import { rollbackForRelease } from './postgres-transaction.mjs';

function userFromRow(row) {
  return row ? { id: row.id, email: row.email, passwordHash: row.password_hash ?? undefined, organizationId: row.organization_id, role: row.role ?? 'user' } : null;
}

function agentFromRow(row) {
  return row ? { id: row.id, organizationId: row.organization_id, ownerUserId: row.owner_user_id, name: row.name, status: row.status, runtimeUrl: row.runtime_url ?? null, host: agentHost(row.id), engine: row.engine, templateId: row.template_id ?? null, templateVersion: row.template_version ?? null, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() } : null;
}

function sessionFromRow(row) {
  return row ? { id: row.id, agentId: row.agent_id, organizationId: row.organization_id, userId: row.user_id, title: row.title, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() } : null;
}

function resourceFromRow(row) {
  return row ? {
    id: row.id,
    organizationId: row.organization_id,
    ownerUserId: row.owner_user_id,
    kind: row.kind,
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    config: row.config ?? {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  } : null;
}

function resourceContentFromRow(row) {
  return row ? {
    id: row.id,
    resourceId: row.resource_id,
    kind: row.kind,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  } : null;
}

function messageFromRow(row) {
  return row ? {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    role: row.role,
    content: row.content,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: new Date(row.created_at).toISOString(),
  } : null;
}

function favoriteFromRow(row) {
  return row ? {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    name: row.target_name ?? row.target_id,
    status: row.target_status ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  } : null;
}

function notificationFromRow(row) {
  return row ? {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body ?? '',
    isRead: row.is_read,
    readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  } : null;
}

function settingFromRow(row) {
  return row ? {
    organizationId: row.organization_id,
    userId: row.user_id,
    displayName: row.display_name ?? null,
    prefs: row.prefs ?? {},
    updatedAt: new Date(row.updated_at).toISOString(),
  } : null;
}

function accountFromRow(row) {
  return row ? {
    organizationId: row.organization_id,
    userId: row.user_id,
    balanceCents: Number(row.balance_cents),
    currency: row.currency,
    updatedAt: new Date(row.updated_at).toISOString(),
  } : null;
}

function transactionFromRow(row) {
  return row ? {
    id: row.id,
    type: row.type,
    amountCents: Number(row.amount_cents),
    balanceAfterCents: Number(row.balance_after_cents),
    referenceType: row.reference_type ?? null,
    referenceId: row.reference_id ?? null,
    description: row.description ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  } : null;
}

function filingFromRow(row) {
  return row ? {
    id: row.id,
    domain: row.domain,
    subjectName: row.subject_name,
    subjectType: row.subject_type,
    icpNumber: row.icp_number ?? null,
    status: row.status,
    remark: row.remark ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  } : null;
}

function formatCents(cents) {
  return (cents / 100).toFixed(2) + ' 元';
}

export class PostgresStore {
  constructor(options = {}) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString ?? process.env.DATABASE_URL, max: options.max ?? Number(process.env.BAIRUI_DB_POOL_MAX ?? 20), idleTimeoutMillis: options.idleTimeoutMillis ?? 30000, connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000, query_timeout: options.queryTimeoutMillis, statement_timeout: options.queryTimeoutMillis });
    this.ownsPool = !options.pool;
    // Idle sockets can fail during database restart; pg removes them from the pool.
    if (this.ownsPool) this.pool.on('error', () => console.error('postgres_pool_idle_connection_error'));
  }

  async ping() { return (await this.pool.query('SELECT 1 AS ok')).rows[0]; }
  async close() { if (this.ownsPool) await this.pool.end(); }

  async ensureDevUser(input) {
    const userId = input.userId ?? input.id;
    if (!userId) throw new Error('dev_user_id_required');
    await this.pool.query('INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [input.organizationId, input.organizationName ?? input.organizationId]);
    await this.pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, lower($2), $3)
      ON CONFLICT (email) DO UPDATE SET password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash)`, [userId, input.email, input.passwordHash]);
    const user = await this.pool.query('SELECT id FROM users WHERE lower(email) = lower($1)', [input.email]);
    await this.pool.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [input.organizationId, user.rows[0].id, input.role ?? 'user']);
    return this.findUserByEmail(input.email);
  }

  async findUserByEmail(email) {
    const r = await this.pool.query(`SELECT u.id, u.email, u.password_hash, om.organization_id, om.role
      FROM users u JOIN organization_members om ON om.user_id = u.id WHERE lower(u.email) = lower($1) ORDER BY om.created_at LIMIT 1`, [email]);
    return userFromRow(r.rows[0]);
  }

  async findUser(userId) {
    const r = await this.pool.query(`SELECT u.id, u.email, u.password_hash, om.organization_id, om.role
      FROM users u JOIN organization_members om ON om.user_id = u.id WHERE u.id = $1 ORDER BY om.created_at LIMIT 1`, [userId]);
    return userFromRow(r.rows[0]);
  }

  async ensureIdentityUser(input) {
    if (!input.subject || !input.email) throw new Error('invalid_identity');
    const email = input.email.trim().toLowerCase();
    const client = await this.pool.connect();
    let releaseError;
    try {
      await client.query('BEGIN');
      // Serialize first access across API replicas; identity and membership commit together.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.subject]);
      const existing = await client.query(
        'SELECT id FROM users WHERE auth_subject = $1', [input.subject]);
      if (existing.rows[0]) {
        const result = await client.query(
          'SELECT u.id, u.email, om.organization_id, om.role FROM users u JOIN organization_members om ON om.user_id = u.id WHERE u.id = $1 ORDER BY om.created_at LIMIT 1',
          [existing.rows[0].id]);
        if (!result.rows[0]) throw new Error('identity_membership_missing');
        await client.query('COMMIT');
        return userFromRow(result.rows[0]);
      }
      const collision = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
      if (collision.rows[0]) throw new Error('identity_link_required');
      const userId = 'user-' + randomUUID();
      const organizationId = 'org-' + randomUUID();
      await client.query('INSERT INTO organizations (id, name, kind) VALUES ($1, $2, $3)',
        [organizationId, email.split('@')[0], 'personal']);
      await client.query('INSERT INTO users (id, email, display_name, auth_subject) VALUES ($1, $2, $3, $4)',
        [userId, email, input.displayName ?? null, input.subject]);
      await client.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'org_admin')", [organizationId, userId]);
      await client.query('COMMIT');
      return { id: userId, email, organizationId, role: 'org_admin' };
    } catch (error) {
      releaseError = await rollbackForRelease(client);
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  // 返回用户所属的全部组织（多组织预留：当前长度为 1）。
  // organizations / organization_members 不启用 RLS，因此无需 scope 上下文。
  async listUserOrganizations(userId) {
    const r = await this.pool.query(`SELECT o.id, o.name, o.kind, om.role
      FROM organization_members om JOIN organizations o ON o.id = om.organization_id
      WHERE om.user_id = $1 ORDER BY om.created_at, o.id`, [userId]);
    return r.rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, role: row.role }));
  }

  // 注册：在同一事务内创建个人组织、用户与组织成员关系，任一失败整体回滚。
  // 邮箱已被占用返回 null（由调用方转为 409）。
  // 个人组织是真实组织，未来升级为团队时只需追加成员，无需迁移业务数据。
  async createUserWithOrganization(input) {
    const email = String(input.email ?? '').trim().toLowerCase();
    if (!email) return null;
    const client = await this.pool.connect();
    let releaseError;
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
      if (existing.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const organizationId = input.organizationId ?? 'org-' + randomUUID();
      const userId = input.userId ?? 'user-' + randomUUID();
      await client.query('INSERT INTO organizations (id, name, kind) VALUES ($1, $2, $3)',
        [organizationId, input.organizationName ?? email, 'personal']);
      await client.query('INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, $3, $4)',
        [userId, email, input.passwordHash, input.displayName ?? null]);
      await client.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'org_admin')`,
        [organizationId, userId]);
      await client.query('COMMIT');
      return { id: userId, email, displayName: input.displayName ?? null, organizationId, role: 'org_admin' };
    } catch (error) {
      releaseError = await rollbackForRelease(client);
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async withScope(scope, fn) {
    const client = await this.pool.connect();
    let releaseError;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)`, [scope.organizationId, scope.userId]);
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) { releaseError = await rollbackForRelease(client); throw error; }
    finally { client.release(releaseError); }
  }

  async listAgents(scope) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT a.*, rr.runtime_url FROM agents a LEFT JOIN runtime_routes rr ON rr.agent_id = a.id
        WHERE a.organization_id = $1 AND a.owner_user_id = $2 ORDER BY a.created_at, a.id`, [scope.organizationId, scope.userId]);
      return r.rows.map(agentFromRow);
    });
  }

  async findAgent(scope, agentId) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT a.*, rr.runtime_url FROM agents a LEFT JOIN runtime_routes rr ON rr.agent_id = a.id
        WHERE a.id = $1 AND a.organization_id = $2 AND a.owner_user_id = $3`, [agentId, scope.organizationId, scope.userId]);
      return agentFromRow(r.rows[0]);
    });
  }

  async listResources(scope, kind) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT * FROM client_resources
        WHERE organization_id = $1 AND owner_user_id = $2 AND ($3::text IS NULL OR kind = $3)
        ORDER BY updated_at DESC, id DESC`, [scope.organizationId, scope.userId, kind ?? null]);
      return r.rows.map(resourceFromRow);
    });
  }

  async findResource(scope, resourceId) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT * FROM client_resources
        WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3`, [resourceId, scope.organizationId, scope.userId]);
      return resourceFromRow(r.rows[0]);
    });
  }

  async createResource(scope, input) {
    const id = input.id ?? 'resource-' + randomUUID();
    const row = await this.withScope(scope, async (c) => {
      const r = await c.query(`INSERT INTO client_resources
        (id, organization_id, owner_user_id, kind, name, description, status, config)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`, [
        id,
        scope.organizationId,
        scope.userId,
        input.kind,
        input.name,
        input.description ?? null,
        input.status ?? 'active',
        JSON.stringify(input.config ?? {}),
      ]);
      if (typeof input.content === 'string' && input.content.trim()) {
        await c.query(`INSERT INTO client_resource_contents (id, organization_id, owner_user_id, resource_id, kind, content)
          VALUES ($1, $2, $3, $4, 'text', $5)`, ['content-' + randomUUID(), scope.organizationId, scope.userId, id, input.content]);
      }
      return r.rows[0];
    });
    return resourceFromRow(row);
  }

  async updateResource(scope, resourceId, input) {
    const row = await this.withScope(scope, async (c) => {
      const r = await c.query(`UPDATE client_resources SET
        name = COALESCE($4, name),
        description = COALESCE($5, description),
        status = COALESCE($6, status),
        config = COALESCE($7::jsonb, config),
        updated_at = now()
        WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3
        RETURNING *`, [
        resourceId,
        scope.organizationId,
        scope.userId,
        input.name ?? null,
        input.description ?? null,
        input.status ?? null,
        input.config === undefined ? null : JSON.stringify(input.config),
      ]);
      return r.rows[0];
    });
    return resourceFromRow(row);
  }

  async deleteResource(scope, resourceId) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`DELETE FROM client_resources
        WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3`, [resourceId, scope.organizationId, scope.userId]);
      return r.rowCount > 0;
    });
  }

  async listResourceContents(scope, resourceId) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT * FROM client_resource_contents
        WHERE resource_id = $1 AND organization_id = $2 AND owner_user_id = $3
        ORDER BY created_at, id`, [resourceId, scope.organizationId, scope.userId]);
      return r.rows.map(resourceContentFromRow);
    });
  }

  async saveResourceContent(scope, resourceId, content) {
    return this.withScope(scope, async (c) => {
      const exists = await c.query(`SELECT 1 FROM client_resources
        WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3`, [resourceId, scope.organizationId, scope.userId]);
      if (!exists.rows[0]) return null;
      await c.query(`DELETE FROM client_resource_contents
        WHERE resource_id = $1 AND organization_id = $2 AND owner_user_id = $3`, [resourceId, scope.organizationId, scope.userId]);
      if (typeof content === 'string' && content.trim()) {
        await c.query(`INSERT INTO client_resource_contents (id, organization_id, owner_user_id, resource_id, kind, content)
          VALUES ($1, $2, $3, $4, 'text', $5)`, ['content-' + randomUUID(), scope.organizationId, scope.userId, resourceId, content]);
      }
      const items = await c.query(`SELECT * FROM client_resource_contents
        WHERE resource_id = $1 AND organization_id = $2 AND owner_user_id = $3
        ORDER BY created_at, id`, [resourceId, scope.organizationId, scope.userId]);
      return items.rows.map(resourceContentFromRow);
    });
  }

  async createAgent(scope, input = {}) {
    const engine = input.engine ?? 'mock';
    if (!['mock', 'pi', 'dsh'].includes(engine)) {
      throw new Error('unsupported_engine');
    }
    const id = input.id ?? 'agent-' + randomUUID();
    const row = await this.withScope(scope, async (c) => {
      // status 必须显式写入：001 迁移里 agents.status 是 NOT NULL 且无 DEFAULT，
      // 而 MemoryStore.createAgent 同样以 'provisioning' 作为初始状态，两个 Store
      // 分支的语义需要保持一致。
      const r = await c.query(`INSERT INTO agents (id, organization_id, owner_user_id, name, engine, runtime_kind, host, status)
        VALUES ($1, $2, $3, $4, $5, $5, $6, 'provisioning') RETURNING *`, [id, scope.organizationId, scope.userId, input.name ?? 'New agent', engine, agentHost(id)]);
      await c.query(`INSERT INTO agent_memberships (organization_id, agent_id, user_id, role) VALUES ($1, $2, $3, 'owner') ON CONFLICT DO NOTHING`, [scope.organizationId, id, scope.userId]);
      await c.query(`INSERT INTO control_outbox (organization_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1, 'agent', $2, 'agent.provision', $3::jsonb)`, [scope.organizationId, id, JSON.stringify({ agentId: id, userId: scope.userId, organizationId: scope.organizationId, engine })]);
      return r.rows[0];
    });
    return agentFromRow(row);
  }

  async markAgentReady(agentId, runtimeUrl, scope) {
    const run = async (c) => {
      const r = await c.query(`UPDATE agents SET status = 'ready', updated_at = now() WHERE id = $1 RETURNING *`, [agentId]);
      if (!r.rows[0]) return null;
      await c.query(`INSERT INTO runtime_routes (agent_id, organization_id, runtime_url, health_status, last_seen_at) VALUES ($1, $2, $3, 'healthy', now()) ON CONFLICT (agent_id) DO UPDATE SET runtime_url = EXCLUDED.runtime_url, health_status = EXCLUDED.health_status, last_seen_at = EXCLUDED.last_seen_at, updated_at = now()`, [agentId, r.rows[0].organization_id, runtimeUrl]);
      return agentFromRow({ ...r.rows[0], runtime_url: runtimeUrl });
    };
    return scope ? this.withScope(scope, run) : run(this.pool);
  }

  async createSession(scope, agentId, title = 'New conversation') {
    return this.withScope(scope, async (c) => {
      const a = await c.query(`SELECT id FROM agents WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3 AND status = 'ready'`, [agentId, scope.organizationId, scope.userId]);
      if (!a.rows[0]) return null;
      const r = await c.query(`INSERT INTO sessions_projection (id, organization_id, user_id, agent_id, title) VALUES ($1, $2, $3, $4, $5) RETURNING *`, ['session-' + randomUUID(), scope.organizationId, scope.userId, agentId, title]);
      return sessionFromRow(r.rows[0]);
    });
  }

  async findSession(scope, agentId, sessionId) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT * FROM sessions_projection WHERE id = $1 AND agent_id = $2 AND organization_id = $3 AND user_id = $4`, [sessionId, agentId, scope.organizationId, scope.userId]);
      return sessionFromRow(r.rows[0]);
    });
  }

  async addMessage(scope, input) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`INSERT INTO conversation_messages (id, organization_id, user_id, agent_id, session_id, role, content, input_tokens, output_tokens)
        SELECT $1, sp.organization_id, sp.user_id, sp.agent_id, sp.id, $2, $3, $4, $5
        FROM sessions_projection sp
        WHERE sp.id = $6 AND sp.organization_id = $7 AND sp.user_id = $8
        RETURNING *`, [
        'msg-' + randomUUID(),
        input.role,
        input.content,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.sessionId,
        scope.organizationId,
        scope.userId,
      ]);
      return messageFromRow(r.rows[0]);
    });
  }

  async listMessages(scope, sessionId) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT * FROM conversation_messages
        WHERE session_id = $1 AND organization_id = $2 AND user_id = $3
        ORDER BY created_at, id`, [sessionId, scope.organizationId, scope.userId]);
      return r.rows.map(messageFromRow);
    });
  }

  async addUsage(scope, amount = 0, context = {}) {
    if (!context.agentId) return;
    await this.withScope(scope, (c) => c.query(`INSERT INTO usage_events (organization_id, user_id, agent_id, session_id, calls, output_tokens) VALUES ($1, $2, $3, $4, 1, $5)`, [scope.organizationId, scope.userId, context.agentId, context.sessionId ?? null, amount]));
  }

  async getUsage(scope, range = 'today') {
    const days = { today: 1, '7d': 7, '30d': 30 }[range] ?? 1;
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total_tokens FROM usage_events WHERE organization_id = $1 AND user_id = $2 AND occurred_at >= now() - ($3 * interval '1 day')`, [scope.organizationId, scope.userId, days]);
      return { range, totalTokens: Number(r.rows[0].total_tokens) };
    });
  }

  async getIdempotency(scope, key) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT request_hash, response_status AS status, response_body AS body FROM idempotency_keys WHERE organization_id = $1 AND user_id = $2 AND idempotency_key = $3 AND expires_at > now()`, [scope.organizationId, scope.userId, key]);
      const row = r.rows[0];
      return row ? { requestHash: row.request_hash, status: row.status, body: row.body, headers: {} } : undefined;
    });
  }

  async setIdempotency(scope, key, value) {
    await this.withScope(scope, (c) => c.query(`INSERT INTO idempotency_keys (organization_id, user_id, idempotency_key, request_hash, response_status, response_body) VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (organization_id, user_id, idempotency_key) DO UPDATE SET request_hash = EXCLUDED.request_hash, response_status = EXCLUDED.response_status, response_body = EXCLUDED.response_body`, [scope.organizationId, scope.userId, key, value.requestHash, value.status, JSON.stringify(value.body)]));
  }

  async claimOutbox(workerId, limit = 10) {
    const c = await this.pool.connect();
    let releaseError;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.worker_id', $1, true)`, [workerId]);
      const r = await c.query(`WITH candidates AS (SELECT id FROM control_outbox WHERE (status = 'queued' AND available_at <= now()) OR (status = 'leased' AND lease_until < now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE control_outbox o SET status = 'leased', leased_by = $2, lease_until = now() + interval '60 seconds', attempts = attempts + 1, updated_at = now() FROM candidates x WHERE o.id = x.id RETURNING o.*`, [limit, workerId]);
      await c.query('COMMIT'); return r.rows;
    } catch (error) { releaseError = await rollbackForRelease(c); throw error; } finally { c.release(releaseError); }
  }

  async completeOutbox(id, workerId, status, lastError = null) {
    const c = await this.pool.connect();
    let releaseError;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.worker_id', $1, true)`, [workerId]);
      await c.query(`UPDATE control_outbox SET status = $3, leased_by = NULL, lease_until = NULL, last_error = $4, updated_at = now() WHERE id = $1 AND leased_by = $2`, [id, workerId, status, lastError]);
      await c.query('COMMIT');
    } catch (error) { releaseError = await rollbackForRelease(c); throw error; }
    finally { c.release(releaseError); }
  }
  async createAuthSession(id, userId, expiresAt) { await this.pool.query('INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [id, userId, new Date(expiresAt)]); return id; }
  async findAuthSession(id) { const r = await this.pool.query('SELECT id, user_id, expires_at FROM auth_sessions WHERE id = $1', [id]); const row = r.rows[0]; return row ? { id: row.id, userId: row.user_id, expiresAt: new Date(row.expires_at).getTime() } : null; }
  async touchAuthSession(id) { await this.pool.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [id]); }
  async deleteAuthSession(id) { await this.pool.query('DELETE FROM auth_sessions WHERE id = $1', [id]); }

  // ---------- 我的收藏 ----------
  async listFavorites(scope) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT f.id, f.target_type, f.target_id, f.created_at,
          COALESCE(a.name, res.name) AS target_name,
          CASE WHEN a.id IS NOT NULL THEN a.status ELSE res.status END AS target_status
        FROM user_favorites f
        LEFT JOIN agents a ON a.id = f.target_id AND a.organization_id = f.organization_id AND a.owner_user_id = f.user_id
        LEFT JOIN client_resources res ON res.id = f.target_id AND res.organization_id = f.organization_id AND res.owner_user_id = f.user_id
        WHERE f.organization_id = $1 AND f.user_id = $2 AND (a.id IS NOT NULL OR res.id IS NOT NULL)
        ORDER BY f.created_at DESC, f.id DESC`, [scope.organizationId, scope.userId]);
      return r.rows.map(favoriteFromRow);
    });
  }

  async addFavorite(scope, targetType, targetId) {
    return this.withScope(scope, async (c) => {
      if (targetType === 'agent') {
        const a = await c.query('SELECT 1 FROM agents WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3', [targetId, scope.organizationId, scope.userId]);
        if (!a.rows[0]) return null;
      } else {
        const res = await c.query('SELECT 1 FROM client_resources WHERE id = $1 AND organization_id = $2 AND owner_user_id = $3', [targetId, scope.organizationId, scope.userId]);
        if (!res.rows[0]) return null;
      }
      const r = await c.query(`INSERT INTO user_favorites (id, organization_id, user_id, target_type, target_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (organization_id, user_id, target_type, target_id) DO NOTHING
        RETURNING id`, ['fav-' + randomUUID(), scope.organizationId, scope.userId, targetType, targetId]);
      const favoriteId = r.rows[0]?.id ?? (await c.query(`SELECT id FROM user_favorites WHERE organization_id = $1 AND user_id = $2 AND target_type = $3 AND target_id = $4`, [scope.organizationId, scope.userId, targetType, targetId])).rows[0].id;
      const view = await c.query(`SELECT f.id, f.target_type, f.target_id, f.created_at,
          COALESCE(a.name, res.name) AS target_name,
          CASE WHEN a.id IS NOT NULL THEN a.status ELSE res.status END AS target_status
        FROM user_favorites f
        LEFT JOIN agents a ON a.id = f.target_id AND a.organization_id = f.organization_id AND a.owner_user_id = f.user_id
        LEFT JOIN client_resources res ON res.id = f.target_id AND res.organization_id = f.organization_id AND res.owner_user_id = f.user_id
        WHERE f.id = $1 AND f.organization_id = $2 AND f.user_id = $3`, [favoriteId, scope.organizationId, scope.userId]);
      return favoriteFromRow(view.rows[0]);
    });
  }

  async removeFavorite(scope, favoriteId) {
    return this.withScope(scope, async (c) => {
      const r = await c.query('DELETE FROM user_favorites WHERE id = $1 AND organization_id = $2 AND user_id = $3', [favoriteId, scope.organizationId, scope.userId]);
      return r.rowCount > 0;
    });
  }

  // ---------- 通知 ----------
  async addNotification(scope, input = {}) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`INSERT INTO user_notifications (id, organization_id, user_id, type, title, body)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        ['notify-' + randomUUID(), scope.organizationId, scope.userId, input.type ?? 'system', input.title ?? '通知', input.body ?? '']);
      return notificationFromRow(r.rows[0]);
    });
  }

  async listNotifications(scope) {
    return this.withScope(scope, async (c) => {
      const items = await c.query(`SELECT * FROM user_notifications
        WHERE organization_id = $1 AND user_id = $2
        ORDER BY created_at DESC, id DESC LIMIT 50`, [scope.organizationId, scope.userId]);
      const unread = await c.query(`SELECT COUNT(*)::int AS count FROM user_notifications
        WHERE organization_id = $1 AND user_id = $2 AND is_read = false`, [scope.organizationId, scope.userId]);
      return { notifications: items.rows.map(notificationFromRow), unreadCount: unread.rows[0].count };
    });
  }

  async markNotificationsRead(scope, notificationId = null) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`UPDATE user_notifications SET is_read = true, read_at = now()
        WHERE organization_id = $1 AND user_id = $2 AND ($3::text IS NULL OR id = $3) AND is_read = false`,
        [scope.organizationId, scope.userId, notificationId]);
      return r.rowCount;
    });
  }

  // ---------- 设置 ----------
  async getSettings(scope) {
    return this.withScope(scope, async (c) => {
      await c.query(`INSERT INTO user_settings (organization_id, user_id) VALUES ($1, $2) ON CONFLICT (organization_id, user_id) DO NOTHING`, [scope.organizationId, scope.userId]);
      const r = await c.query('SELECT * FROM user_settings WHERE organization_id = $1 AND user_id = $2', [scope.organizationId, scope.userId]);
      return settingFromRow(r.rows[0]);
    });
  }

  async updateSettings(scope, input = {}) {
    return this.withScope(scope, async (c) => {
      await c.query(`INSERT INTO user_settings (organization_id, user_id) VALUES ($1, $2) ON CONFLICT (organization_id, user_id) DO NOTHING`, [scope.organizationId, scope.userId]);
      const sets = ['updated_at = now()'];
      const values = [scope.organizationId, scope.userId];
      if (input.displayName !== undefined) {
        sets.push('display_name = $' + (values.length + 1));
        values.push(input.displayName ?? null);
      }
      if (input.prefs !== undefined) {
        sets.push(`prefs = COALESCE(prefs, '{}'::jsonb) || $` + (values.length + 1) + '::jsonb');
        values.push(JSON.stringify(input.prefs ?? {}));
      }
      const r = await c.query('UPDATE user_settings SET ' + sets.join(', ') + ' WHERE organization_id = $1 AND user_id = $2 RETURNING *', values);
      return settingFromRow(r.rows[0]);
    });
  }

  // ---------- 费用中心 ----------
  async #upsertAccount(c, organizationId, userId) {
    await c.query('INSERT INTO user_accounts (organization_id, user_id) VALUES ($1, $2) ON CONFLICT (organization_id, user_id) DO NOTHING', [organizationId, userId]);
    const r = await c.query('SELECT * FROM user_accounts WHERE organization_id = $1 AND user_id = $2', [organizationId, userId]);
    return accountFromRow(r.rows[0]);
  }

  async getAccount(scope) {
    return this.withScope(scope, async (c) => this.#upsertAccount(c, scope.organizationId, scope.userId));
  }

  async listTransactions(scope, limit = 100) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT * FROM account_transactions
        WHERE organization_id = $1 AND user_id = $2
        ORDER BY created_at DESC, id DESC LIMIT $3`, [scope.organizationId, scope.userId, limit]);
      return r.rows.map(transactionFromRow);
    });
  }

  async recharge(scope, input = {}) {
    return this.withScope(scope, async (c) => {
      const account = await this.#upsertAccount(c, scope.organizationId, scope.userId);
      const after = account.balanceCents + input.amountCents;
      await c.query('UPDATE user_accounts SET balance_cents = $3, updated_at = now() WHERE organization_id = $1 AND user_id = $2', [scope.organizationId, scope.userId, after]);
      const r = await c.query(`INSERT INTO account_transactions (id, organization_id, user_id, type, amount_cents, balance_after_cents, description)
        VALUES ($1, $2, $3, 'recharge', $4, $5, $6) RETURNING *`,
        ['tx-' + randomUUID(), scope.organizationId, scope.userId, input.amountCents, after, input.description ?? '账户充值']);
      await c.query(`INSERT INTO user_notifications (id, organization_id, user_id, type, title, body) VALUES ($1, $2, $3, 'billing', $4, $5)`,
        ['notify-' + randomUUID(), scope.organizationId, scope.userId, '充值成功', '账户到账 ' + formatCents(input.amountCents) + '，当前余额 ' + formatCents(after) + '。']);
      return transactionFromRow(r.rows[0]);
    });
  }

  async chargeForUsage(scope, input = {}) {
    return this.withScope(scope, async (c) => {
      const account = await this.#upsertAccount(c, scope.organizationId, scope.userId);
      const after = account.balanceCents - input.amountCents;
      await c.query('UPDATE user_accounts SET balance_cents = $3, updated_at = now() WHERE organization_id = $1 AND user_id = $2', [scope.organizationId, scope.userId, after]);
      const r = await c.query(`INSERT INTO account_transactions (id, organization_id, user_id, type, amount_cents, balance_after_cents, reference_type, reference_id, description)
        VALUES ($1, $2, $3, 'consume', $4, $5, $6, $7, $8) RETURNING *`,
        ['tx-' + randomUUID(), scope.organizationId, scope.userId, input.amountCents, after, input.agentId ? 'agent' : null, input.agentId ?? null, input.description ?? 'Agent 调用扣费']);
      if (after < 0) {
        await c.query(`INSERT INTO user_notifications (id, organization_id, user_id, type, title, body) VALUES ($1, $2, $3, 'billing', $4, $5)`,
          ['notify-' + randomUUID(), scope.organizationId, scope.userId, '账户余额不足', '扣费后余额为 ' + formatCents(after) + '，请及时充值以免影响 Agent 服务。']);
      }
      return transactionFromRow(r.rows[0]);
    });
  }

  // ---------- 备案 ----------
  async listFilings(scope) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`SELECT * FROM icp_filings
        WHERE organization_id = $1 AND owner_user_id = $2
        ORDER BY created_at DESC, id DESC`, [scope.organizationId, scope.userId]);
      return r.rows.map(filingFromRow);
    });
  }

  async createFiling(scope, input = {}) {
    return this.withScope(scope, async (c) => {
      const r = await c.query(`INSERT INTO icp_filings (id, organization_id, owner_user_id, domain, subject_name, subject_type, icp_number, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted') RETURNING *`,
        ['filing-' + randomUUID(), scope.organizationId, scope.userId, input.domain, input.subjectName, input.subjectType ?? 'enterprise', input.icpNumber ?? null]);
      await c.query(`INSERT INTO user_notifications (id, organization_id, user_id, type, title, body) VALUES ($1, $2, $3, 'system', $4, $5)`,
        ['notify-' + randomUUID(), scope.organizationId, scope.userId, '备案提交成功', '域名「' + input.domain + '」的备案申请已提交，状态为审核中。']);
      return filingFromRow(r.rows[0]);
    });
  }
}
