// Pass the result to client.release so an uncertain transaction is never reused.
export async function rollbackForRelease(client) {
  try { await client.query('ROLLBACK'); }
  catch (error) { return error || true; }
}
