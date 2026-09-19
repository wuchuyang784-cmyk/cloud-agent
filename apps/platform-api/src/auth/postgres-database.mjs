import { Kysely, PostgresDialect } from 'kysely';

function sourceTable(node) {
  if (node?.kind === 'AliasNode') return sourceTable(node.node);
  if (node?.kind === 'TableNode') return node.table?.identifier?.name;
  if (node?.kind === 'SelectQueryNode' && !node.joins?.length && node.from?.froms?.length === 1) return sourceTable(node.from.froms[0]);
  return null;
}

export function rateLimitTimestampPlugin() {
  const queries = new WeakSet();
  return {
    transformQuery({ node, queryId }) {
      if (node.kind === 'SelectQueryNode' && sourceTable(node) === 'ba_rate_limit') queries.add(queryId);
      return node;
    },
    async transformResult({ result, queryId }) {
      if (!queries.has(queryId)) return result;
      queries.delete(queryId);
      return { ...result, rows: result.rows.map(row => {
        if (!Object.hasOwn(row, 'lastRequest')) return row;
        const value = row.lastRequest;
        if (!['number', 'bigint', 'string'].includes(typeof value) || (typeof value === 'string' && !/^\d+$/.test(value))) {
          throw new Error('invalid_rate_limit_timestamp');
        }
        const timestamp = Number(value);
        if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('invalid_rate_limit_timestamp');
        return { ...row, lastRequest: timestamp };
      }) };
    },
  };
}

export function authPostgresDatabase(pool) {
  // pg returns int8 as strings; Better Auth 1.7.5 requires a numeric lastRequest.
  // Scope the conversion to this auth query, preserving business bigint precision.
  return {
    db: new Kysely({ dialect: new PostgresDialect({ pool }), plugins: [rateLimitTimestampPlugin()] }),
    type: 'postgres',
    transaction: true,
  };
}
