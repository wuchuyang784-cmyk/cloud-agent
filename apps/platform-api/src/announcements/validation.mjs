const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actions = {
  create: ['title', 'body', 'severity', 'pinned', 'expiresAt', 'expiryDays'],
  edit: ['title', 'body', 'severity', 'pinned', 'expiresAt', 'expiryDays'],
  publish: [], schedule: ['scheduledAt'], cancel: [], withdraw: ['reason'],
};
export const isAnnouncementId = value => typeof value === 'string' && uuid.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const length = value => [...value].length;
const text = (value, max, multiline = false) => typeof value === 'string' && value.trim().length > 0
  && length(value) <= max && !(multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value);

export function announcementTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.test(value)) return null;
  const local = value.slice(0, 19), localDate = new Date(local + 'Z');
  if (!Number.isFinite(localDate.valueOf()) || localDate.toISOString().slice(0, 19) !== local || !Number.isFinite(Date.parse(value))) return null;
  const normalized = new Date(value).toISOString();
  if (normalized.length !== 24 || normalized.startsWith('0000') || value.startsWith('0000')) return null;
  return normalized;
}

export function normalizeCommand(input) {
  if (!object(input) || !Object.hasOwn(actions, input.action)) return null;
  const allowed = ['action', 'requestId', ...actions[input.action], ...(input.action === 'create' ? [] : ['id', 'expectedVersion'])];
  if (Object.keys(input).some(key => !allowed.includes(key)) || !isAnnouncementId(input.requestId)) return null;
  const result = { action: input.action, requestId: input.requestId.toLowerCase() };
  if (input.action !== 'create') {
    if (!isAnnouncementId(input.id) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || input.expectedVersion > 2147483646) return null;
    Object.assign(result, { id: input.id.toLowerCase(), expectedVersion: input.expectedVersion });
  }
  if (['create', 'edit'].includes(input.action)) {
    if (!text(input.title, 120) || !text(input.body, 20000, true)
      || ('severity' in input && !['normal', 'important'].includes(input.severity))
      || ('pinned' in input && typeof input.pinned !== 'boolean')) return null;
    Object.assign(result, { title: input.title.trim(), body: input.body.trim() });
    if (input.action === 'create' || 'severity' in input) result.severity = input.severity ?? 'normal';
    if (input.action === 'create' || 'pinned' in input) result.pinned = input.pinned ?? false;
    if ('expiryDays' in input) {
      if (input.expiryDays !== 30 || 'expiresAt' in input) return null;
      result.expiryDays = 30;
    }
    if ('expiresAt' in input) {
      if (input.expiresAt !== null && !announcementTime(input.expiresAt)) return null;
      result.expiresAt = input.expiresAt === null ? null : announcementTime(input.expiresAt);
    }
  }
  if (input.action === 'schedule') {
    result.scheduledAt = announcementTime(input.scheduledAt);
    if (!result.scheduledAt) return null;
  }
  if (input.action === 'withdraw') {
    if (!text(input.reason, 500)) return null;
    result.reason = input.reason.trim();
  }
  return result;
}

export function normalizeQuery(input = {}, user = false) {
  if (!object(input) || Object.keys(input).some(key => !(user ? ['id', 'after', 'limit', 'history'] : ['id', 'after', 'limit', 'status', 'audit', 'q']).includes(key))) return null;
  const result = { limit: 25, ...input };
  if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 100
    || ('id' in result && !isAnnouncementId(result.id))
    || ('audit' in result && typeof result.audit !== 'boolean')
    || ('history' in result && typeof result.history !== 'boolean')
    || (result.audit && !result.id)
    || ('status' in result && !['draft', 'scheduled', 'published', 'withdrawn', 'expired'].includes(result.status))
    || ('q' in result && (typeof result.q !== 'string' || [...result.q].length > 200 || /[\x00-\x1f\x7f]/.test(result.q)))
    || ('after' in result && (typeof result.after !== 'string' || !(result.audit ? /^[1-9][0-9]{0,17}$/.test(result.after) : isAnnouncementId(result.after))))) return null;
  for (const key of ['id', 'after']) if (typeof result[key] === 'string') result[key] = result[key].toLowerCase();
  return result;
}
