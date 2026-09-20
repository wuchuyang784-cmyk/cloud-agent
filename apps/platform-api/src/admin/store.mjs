import { rollbackForRelease } from '../postgres-transaction.mjs';
import { projectInfrastructure } from './infrastructure.mjs';
import { accountAccess } from './governance.mjs';

const roles = new Set(['platform_viewer', 'platform_operator', 'platform_admin']);
const permissions = ['users:read', 'agents:read', 'infrastructure:read'];
const safeUser = user => ({ id: user.id, email: user.email, displayName: user.displayName ?? null,
  createdAt: user.createdAt ?? null, authLinked: Boolean(user.authSubject?.startsWith('better-auth:')) });

export async function readAdmin(store, actor, resource, query = {}) {
  if ((await accountAccess(store, actor)).status !== 'active') return null;
  const { q = '', after = '', limit = 25, ownerUserId = '', status = '' } = query;
  if (store.pool) {
    const client = await store.pool.connect();
    let releaseError;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '3s'");
      const result = resource === 'infrastructure'
        ? await client.query('SELECT platform_infrastructure_read($1) AS result', [actor])
        : await client.query('SELECT platform_admin_read($1,$2,$3,$4,$5,$6,$7) AS result',
          [actor, resource, q, after, limit, ownerUserId, status]);
      const value = result.rows[0].result;
      const accounts = resource === 'users' && value
        ? (await client.query('SELECT platform_governance_accounts($1,$2) AS result', [actor, value.items.map(row => row.id)])).rows[0].result : null;
      await client.query('COMMIT');
      if (!value) return null;
      if (resource === 'me' && roles.has(value.role)) return { ...value, permissions: [...permissions, ...(value.role === 'platform_admin' ? ['users:govern'] : [])] };
      if (resource === 'users') {
        if (!accounts) return null;
        return { ...value, items: value.items.map(row => ({ ...row, account: accounts[row.id] })) };
      }
      return resource === 'infrastructure' ? projectInfrastructure(value) : value;
    } catch (error) {
      releaseError = await rollbackForRelease(client);
      throw error;
    } finally { client.release(releaseError); }
  }
  const binding = store.platformRoles?.get(actor);
  if (!roles.has(binding?.role) || binding.revokedAt || !store.users.has(actor)) return null;
  if (resource === 'me') return { role: binding.role, permissions: [...permissions, ...(binding.role === 'platform_admin' ? ['users:govern'] : [])], user: safeUser(store.users.get(actor)) };
  if (resource === 'infrastructure') {
    const sources = [...(store.infrastructureSources?.values() ?? [])].filter(source => source.enabled !== false).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    return projectInfrastructure({ items: sources.slice(0, 20), truncated: sources.length > 20 });
  }
  const rows = resource === 'users' ? [...store.users.values()].map(user => ({ ...safeUser(user), account: store.accountGovernance?.get(user.id) ?? { status: 'active', version: 0, changedAt: null } })) : [...store.agents.values()].map(agent => ({
    id: agent.id, name: agent.name, organizationId: agent.organizationId, ownerUserId: agent.ownerUserId,
    ownerEmail: store.users.get(agent.ownerUserId)?.email ?? null, status: agent.status, engine: agent.engine ?? 'mock',
    createdAt: agent.createdAt ?? null, updatedAt: agent.updatedAt ?? null,
  }));
  const filtered = rows.filter(row => row.id > after && (!ownerUserId || row.ownerUserId === ownerUserId)
    && (!status || row.status === status)
    && [row.id, row.email, row.displayName, row.name, row.ownerEmail].some(value => String(value ?? '').toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const items = filtered.slice(0, limit);
  return { items, nextCursor: filtered.length > limit ? items.at(-1).id : null };
}
