const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const fixedRoutes = new Set([
  '/livez', '/readyz', '/healthz',
  '/api/admin/me', '/api/admin/users', '/api/admin/agents',
  '/api/auth/config', '/api/auth/me', '/api/auth/register', '/api/auth/login',
  '/api/auth/dev-login', '/api/auth/logout', '/api/auth/sign-up/email',
  '/api/auth/sign-in/email', '/api/auth/sign-out', '/api/simulation/tasks',
  '/api/user/resources', '/api/user/agents', '/api/user/usage', '/api/user/favorites',
  '/api/user/notifications', '/api/user/notifications/read-all', '/api/user/settings',
  '/api/user/account', '/api/user/billing/transactions', '/api/user/billing/recharge',
  '/api/user/filings',
  '/api/user/monitoring/agents',
]);
const dynamicRoutes = [
  [/^\/api\/admin\/users\/[^/]+\/governance$/, '/api/admin/users/:userId/governance'],
  [/^\/api\/user\/monitoring\/agents\/[^/]+$/, '/api/user/monitoring/agents/:agentId'],
  [/^\/api\/user\/resources\/[^/]+$/, '/api/user/resources/:resourceId'],
  [/^\/api\/user\/agents\/[^/]+$/, '/api/user/agents/:agentId'],
  [/^\/api\/user\/agents\/[^/]+\/sessions$/, '/api/user/agents/:agentId/sessions'],
  [/^\/api\/user\/agents\/[^/]+\/sessions\/[^/]+\/messages$/, '/api/user/agents/:agentId/sessions/:sessionId/messages'],
  [/^\/api\/user\/agents\/[^/]+\/sessions\/[^/]+\/chat\/stream$/, '/api/user/agents/:agentId/sessions/:sessionId/chat/stream'],
  [/^\/api\/user\/favorites\/[^/]+$/, '/api/user/favorites/:favoriteId'],
  [/^\/api\/user\/notifications\/[^/]+$/, '/api/user/notifications/:notificationId'],
  [/^\/api\/simulation\/tasks\/[a-zA-Z0-9-]+$/, '/api/simulation/tasks/:taskId'],
  [/^\/api\/simulation\/tasks\/[a-zA-Z0-9-]+\/cancel$/, '/api/simulation/tasks/:taskId/cancel'],
];
const routeLabels = new Set([...fixedRoutes, ...dynamicRoutes.map(([, label]) => label)]);

export function methodLabel(method) { return methods.has(method) ? method : 'OTHER'; }

export function statusLabel(status) {
  return /^(?:[1-5][0-9]{2})$/.test(String(status)) ? String(status) : 'other';
}

export function routeLabel(url) {
  let path;
  try { path = new URL(url, 'http://platform.local').pathname; }
  catch { return 'unmatched'; }
  if (fixedRoutes.has(path)) return path;
  return dynamicRoutes.find(([pattern]) => pattern.test(path))?.[1] ?? 'unmatched';
}

export function allowedRouteLabel(label) { return routeLabels.has(label) ? label : 'unmatched'; }
