import { rollbackForRelease } from '../postgres-transaction.mjs';

const queries = {
  change: 'SELECT platform_announcement_change($1,$2::jsonb) AS result',
  read: 'SELECT platform_announcement_read($1,$2::jsonb) AS result',
  user: 'SELECT platform_announcement_user_read($1,$2,$3::jsonb) AS result',
  mark: 'SELECT platform_announcement_mark_read($1,$2,$3::uuid) AS result',
  centerRead: 'SELECT platform_notification_center_read($1,$2,$3::jsonb) AS result',
  centerMark: 'SELECT platform_notification_center_mark($1,$2,$3) AS result',
  centerAll: 'SELECT platform_notification_center_all($1,$2,$3::uuid) AS result',
};

export class AnnouncementUnavailable extends Error {
  constructor() { super('announcements_unavailable'); this.code = 'announcements_unavailable'; this.status = 503; }
}

export async function announcementQuery(store, operation, parameters) {
  let client, releaseError;
  try {
    client = await store.pool.connect();
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL statement_timeout = '3s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await client.query(queries[operation], parameters);
    await client.query('COMMIT');
    return result.rows[0].result;
  } catch {
    if (client) releaseError = await rollbackForRelease(client);
    throw new AnnouncementUnavailable();
  } finally { client?.release(releaseError); }
}
