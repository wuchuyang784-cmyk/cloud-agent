import { normalizeCommand, normalizeQuery, isAnnouncementId } from './validation.mjs';
import { changeMemory, readMemory, readUserMemory, markMemory } from './memory.mjs';

export async function changeAnnouncement(store, actor, input, options = {}) {
  const command = normalizeCommand(input);
  if (!command) return { error: 'invalid_announcement_input' };
  if (store.pool) return (await import('./postgres.mjs')).announcementQuery(store, 'change', [actor, command]);
  return changeMemory(store, actor, command, options.now);
}

export async function readAnnouncements(store, actor, input = {}) {
  const query = normalizeQuery(input);
  if (!query) return { error: 'invalid_announcement_query' };
  if (store.pool) return (await import('./postgres.mjs')).announcementQuery(store, 'read', [actor, query]);
  return readMemory(store, actor, query);
}

export async function readUserAnnouncements(store, scope, input = {}) {
  const query = normalizeQuery(input, true);
  if (!query) return { error: 'invalid_announcement_query' };
  if (store.pool) return (await import('./postgres.mjs')).announcementQuery(store, 'user', [scope?.userId ?? null, scope?.organizationId ?? null, query]);
  return readUserMemory(store, scope, query);
}

export async function markAnnouncementRead(store, scope, id) {
  if (!isAnnouncementId(id)) return { error: 'invalid_announcement_input' };
  if (store.pool) return (await import('./postgres.mjs')).announcementQuery(store, 'mark', [scope?.userId ?? null, scope?.organizationId ?? null, id.toLowerCase()]);
  return markMemory(store, scope, id.toLowerCase());
}
