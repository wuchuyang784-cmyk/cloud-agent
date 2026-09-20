import { allowedRouteLabel, methodLabel, statusLabel } from './labels.mjs';

const events = new Set([
  'http_request_error', 'runtime_provision_error', 'auth_event',
  'api_started', 'api_startup_error', 'api_shutdown_error', 'metrics_scrape_error',
  'client_monitoring_unavailable',
]);

// Rebuild records from finite vocabularies. Never serialize caught objects or their messages.
export function safeLog(event, fields = {}) {
  const level = ['info', 'warn', 'error'].includes(fields.level) ? fields.level : 'error';
  const record = { timestamp: new Date().toISOString(), level, event: events.has(event) ? event : 'internal_error' };
  if (typeof fields.requestId === 'string' && /^req_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(fields.requestId)) {
    record.requestId = fields.requestId;
  }
  if (fields.method !== undefined) record.method = methodLabel(fields.method);
  if (fields.route !== undefined) record.route = allowedRouteLabel(fields.route);
  if (fields.status !== undefined) record.status = statusLabel(fields.status);
  const write = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
  write(JSON.stringify(record));
}
