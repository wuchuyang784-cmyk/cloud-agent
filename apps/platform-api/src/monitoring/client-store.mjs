const dayMs = 86400000;
const shanghaiOffset = 8 * 3600000;
const statuses = new Set(['uninitialized', 'provisioning', 'starting', 'ready', 'degraded', 'offline', 'failed', 'stopped']);
const healthStatuses = new Set(['healthy', 'unhealthy', 'degraded', 'unknown']);

export function monitoringWindow(range, now = new Date()) {
  const days = { today: 1, '7d': 7, '30d': 30 }[range];
  if (!days || !Number.isFinite(now.getTime())) throw new Error('invalid_monitoring_window');
  const midnight = Math.floor((now.getTime() + shanghaiOffset) / dayMs) * dayMs - shanghaiOffset;
  return { range, timezone: 'Asia/Shanghai', from: new Date(midnight - (days - 1) * dayMs).toISOString(), to: now.toISOString() };
}

function date(value) {
  if (!value) return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function agentView(row, now) {
  const recordedAt = date(row.lastSeenAt);
  const age = recordedAt ? now.getTime() - Date.parse(recordedAt) : null;
  return { id: row.id, name: row.name, engine: ['mock', 'pi', 'dsh'].includes(row.engine) ? row.engine : 'unknown',
    recordStatus: statuses.has(row.status) ? row.status : 'unknown', recordUpdatedAt: date(row.updatedAt),
    routeRecord: { source: 'lifecycle_record', health: healthStatuses.has(row.healthStatus) ? row.healthStatus : 'unknown',
      recordedAt, freshness: age === null ? 'missing' : age < 0 ? 'invalid' : age > 300000 ? 'stale' : 'recent', staleAfterSeconds: 300 } };
}

function summary(rows) {
  const sum = key => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const safe = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const events = sum('events');
  const latencySamples = sum('latencySamples');
  const latencyTotal = sum('latencyTotal');
  return { events: safe(events), calls: events ? safe(sum('calls')) : null,
    failedCalls: events ? safe(sum('failedCalls')) : null, tokens: events ? safe(sum('tokens')) : null,
    latencySamples: safe(latencySamples), avgLatencyMs: latencySamples && safe(latencyTotal) !== null
      ? latencyTotal / latencySamples : null, successRate: null };
}

function detail(row, rows, window, now) {
  return { fetchedAt: now.toISOString(), agent: agentView(row, now),
    live: { status: 'not_connected', sampledAt: null, cpuPercent: null, memoryBytes: null },
    usage: { ...window, source: 'usage_events', coverage: 'recorded_only',
      lastRecordedAt: rows.map(row => date(row.lastRecordedAt)).filter(Boolean).sort().at(-1) ?? null,
      summary: summary(rows), series: rows.map(row => ({ day: row.day, ...summary([row]) })) } };
}

const projection = `a.id, a.name, a.engine, a.status, a.updated_at AS "updatedAt",
  r.health_status AS "healthStatus", r.last_seen_at AS "lastSeenAt"`;
const routeJoin = 'LEFT JOIN runtime_routes r ON r.agent_id = a.id AND r.organization_id = a.organization_id';

export async function readClientMonitoring(store, scope, query, now = new Date()) {
  if (!scope?.userId || !scope?.organizationId) throw new Error('missing_monitoring_scope');
  const window = query.agentId ? monitoringWindow(query.range, now) : null;
  if (store.pool) {
    return store.withScope(scope, async client => {
      await client.query("SET LOCAL statement_timeout = '3s'");
      if (!query.agentId) {
        const result = await client.query(`SELECT ${projection} FROM agents a ${routeJoin}
          WHERE a.organization_id = $1 AND a.owner_user_id = $2 AND ($3::text IS NULL OR a.id > $3)
          AND ($4 = '' OR strpos(lower(a.name), lower($4)) > 0 OR strpos(lower(a.id), lower($4)) > 0)
          ORDER BY a.id LIMIT $5`, [scope.organizationId, scope.userId, query.after ?? null, query.q ?? '', query.limit + 1]);
        return page(result.rows, query.limit, now);
      }
      // One statement keeps ownership, route record and bounded aggregation on one snapshot.
      const result = await client.query(`SELECT ${projection}, COALESCE((SELECT jsonb_agg(d ORDER BY d.day) FROM (
          SELECT to_char(occurred_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
            count(*) AS events, sum(calls) AS calls, sum(failed_calls) AS "failedCalls",
            sum(input_tokens::numeric + output_tokens::numeric) AS tokens,
            count(latency_ms) AS "latencySamples", sum(latency_ms) AS "latencyTotal",
            max(occurred_at) AS "lastRecordedAt"
          FROM usage_events WHERE organization_id = $1 AND user_id = $2 AND agent_id = a.id
            AND occurred_at >= $4::timestamptz AND occurred_at <= $5::timestamptz GROUP BY 1
        ) d), '[]'::jsonb) AS usage FROM agents a ${routeJoin}
        WHERE a.organization_id = $1 AND a.owner_user_id = $2 AND a.id = $3`,
      [scope.organizationId, scope.userId, query.agentId, window.from, window.to]);
      const row = result.rows[0];
      return row ? detail(row, row.usage, window, now) : null;
    });
  }
  const owns = row => row.organizationId === scope.organizationId && row.ownerUserId === scope.userId;
  const viewRow = row => {
    const route = store.runtimeRoutes.get(row.id);
    return { ...row, ...(route?.organizationId === row.organizationId
      ? { lastSeenAt: route.lastSeenAt, healthStatus: route.healthStatus } : {}) };
  };
  if (!query.agentId) {
    const q = (query.q ?? '').toLowerCase();
    const rows = [...store.agents.values()].filter(owns)
      .filter(row => (!query.after || row.id > query.after) && (!q || row.name.toLowerCase().includes(q) || row.id.toLowerCase().includes(q)))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, query.limit + 1).map(viewRow);
    return page(rows, query.limit, now);
  }
  const row = store.agents.get(query.agentId);
  if (!row || !owns(row)) return null;
  const groups = new Map();
  for (const event of store.usageEvents) {
    const time = Date.parse(event.occurredAt);
    if (event.organizationId !== scope.organizationId || event.userId !== scope.userId || event.agentId !== row.id
      || !Number.isFinite(time) || time < Date.parse(window.from) || time > Date.parse(window.to)) continue;
    const day = new Date(time + shanghaiOffset).toISOString().slice(0, 10);
    const group = groups.get(day) ?? { day, events: 0, calls: 0, failedCalls: 0, tokens: 0, latencySamples: 0, latencyTotal: 0, lastRecordedAt: null };
    group.events++; group.calls += Number(event.calls ?? 1); group.failedCalls += Number(event.failedCalls ?? 0);
    group.tokens += Number(event.inputTokens ?? 0) + Number(event.outputTokens ?? 0);
    if (event.latencyMs != null) { group.latencySamples++; group.latencyTotal += Number(event.latencyMs); }
    if (!group.lastRecordedAt || time > Date.parse(group.lastRecordedAt)) group.lastRecordedAt = new Date(time).toISOString();
    groups.set(day, group);
  }
  return detail(viewRow(row), [...groups.values()].sort((a, b) => a.day.localeCompare(b.day)), window, now);
}

function page(rows, limit, now) {
  return { fetchedAt: now.toISOString(), items: rows.slice(0, limit).map(row => agentView(row, now)),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null };
}
