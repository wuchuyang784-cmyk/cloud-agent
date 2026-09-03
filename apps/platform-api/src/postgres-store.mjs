import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { agentHost } from './agent-host.mjs';

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

export class PostgresStore {
  constructor(options = {}) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString ?? process.env.DATABASE_URL, max: options.max ?? Number(process.env.BAIRUI_DB_POOL_MAX ?? 20), idleTimeoutMillis: options.idleTimeoutMillis ?? 30000, connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000 });
    this.ownsPool = !options.pool;
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

  async withScope(scope, fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)`, [scope.organizationId, scope.userId]);
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
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
    const id = input.id ?? 'agent-' + randomUUID();
    const row = await this.withScope(scope, async (c) => {
      const r = await c.query(`INSERT INTO agents (id, organization_id, owner_user_id, name, status, runtime_kind, host)
        VALUES ($1, $2, $3, $4, 'provisioning', 'mock', $5) RETURNING *`, [id, scope.organizationId, scope.userId, input.name ?? 'New agent', agentHost(id)]);
      await c.query(`INSERT INTO agent_memberships (organization_id, agent_id, user_id, role) VALUES ($1, $2, $3, 'owner') ON CONFLICT DO NOTHING`, [scope.organizationId, id, scope.userId]);
      await c.query(`INSERT INTO control_outbox (organization_id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1, 'agent', $2, 'agent.provision', $3::jsonb)`, [scope.organizationId, id, JSON.stringify({ agentId: id, userId: scope.userId, organizationId: scope.organizationId })]);
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
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.worker_id', $1, true)`, [workerId]);
      const r = await c.query(`WITH candidates AS (SELECT id FROM control_outbox WHERE (status = 'queued' AND available_at <= now()) OR (status = 'leased' AND lease_until < now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE control_outbox o SET status = 'leased', leased_by = $2, lease_until = now() + interval '60 seconds', attempts = attempts + 1, updated_at = now() FROM candidates x WHERE o.id = x.id RETURNING o.*`, [limit, workerId]);
      await c.query('COMMIT'); return r.rows;
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  }

  async completeOutbox(id, workerId, status, lastError = null) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.worker_id', $1, true)`, [workerId]);
      await c.query(`UPDATE control_outbox SET status = $3, leased_by = NULL, lease_until = NULL, last_error = $4, updated_at = now() WHERE id = $1 AND leased_by = $2`, [id, workerId, status, lastError]);
      await c.query('COMMIT');
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async createAuthSession(id, userId, expiresAt) { await this.pool.query('INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [id, userId, new Date(expiresAt)]); return id; }
  async findAuthSession(id) { const r = await this.pool.query('SELECT id, user_id, expires_at FROM auth_sessions WHERE id = $1', [id]); const row = r.rows[0]; return row ? { id: row.id, userId: row.user_id, expiresAt: new Date(row.expires_at).getTime() } : null; }
  async touchAuthSession(id) { await this.pool.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [id]); }
  async deleteAuthSession(id) { await this.pool.query('DELETE FROM auth_sessions WHERE id = $1', [id]); }
}
