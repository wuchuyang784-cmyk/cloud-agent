import { setTimeout as delay } from 'node:timers/promises';

export async function waitForPostgres(createClient, { attempts = 30, pause = () => delay(1000) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const client = createClient();
    // A startup disconnect may also arrive as an idle-client error event.
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('SELECT 1');
      return;
    } catch {
      // Retry only readiness, never a partially executed integration test.
    } finally {
      await client.end().catch(() => {});
    }
    if (attempt + 1 < attempts) await pause();
  }
  throw new Error('test_database_start_timeout');
}
