// Recovery evidence is tied to the actual process recovery, not the day on
// which a later read-only verification happens to run.
export function hasPersistedResolution(records, alertname, recoveredAt) {
  const cutoff = Date.parse(recoveredAt);
  if (!Number.isFinite(cutoff)) return false;
  let latest;
  for (const row of records) {
    if (row.alertname !== alertname) continue;
    const timestamp = Date.parse(row.receivedAt);
    if (!Number.isFinite(timestamp)) return false;
    if (!latest || timestamp > latest.timestamp || (timestamp === latest.timestamp && row.status !== 'resolved')) {
      latest = { timestamp, status: row.status };
    }
  }
  return latest?.status === 'resolved' && latest.timestamp >= cutoff;
}
