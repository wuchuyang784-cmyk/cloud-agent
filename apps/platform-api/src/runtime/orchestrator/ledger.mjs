export class MemoryOrchestratorLedger {
  constructor() { this.records = new Map(); this.locks = new Map(); this.nonces = new Map(); }
  async read(id) { return structuredClone(this.records.get(id) ?? null); }
  async withRun(id, callback) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    this.locks.set(id, next);
    await previous;
    try {
      return await callback({ read: () => this.read(id), save: async row => { this.records.set(id, structuredClone(row)); } });
    } finally { release(); if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  async list(limit = 32) {
    return [...this.records.values()].filter(row => !['stopped', 'absent'].includes(row.phase))
      .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0)).slice(0, limit).map(row => row.runId);
  }
  async consume(keyId, nonce, expiresAt, now) {
    for (const [key, expiry] of this.nonces) if (expiry < now) this.nonces.delete(key);
    const key = `${keyId}:${nonce}`;
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, expiresAt); return true;
  }
}

export class PostgresOrchestratorLedger {
  constructor({ pool, installationId }) { this.pool = pool; this.installationId = installationId; }
  async check() {
    const { rows } = await this.pool.query('SELECT installation_id FROM bairui_orchestrator.installation WHERE singleton');
    if (rows.length !== 1 || rows[0].installation_id !== this.installationId) throw new Error('ledger_installation_mismatch');
  }
  async read(id) {
    return (await this.pool.query('SELECT record FROM bairui_orchestrator.runs WHERE run_id=$1', [id])).rows[0]?.record ?? null;
  }
  async withRun(id, callback) {
    const client = await this.pool.connect();
    let broken = false; let locked = false;
    const onError = () => { broken = true; };
    client.on('error', onError);
    const query = async (sql, args) => {
      if (broken) throw new Error('ledger_unavailable');
      return client.query(sql, args);
    };
    const key = `${this.installationId}:${id}`;
    try {
      locked = (await query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [key])).rows[0].locked;
      if (!locked) throw new Error('run_busy');
      return await callback({
        read: async () => (await query('SELECT record FROM bairui_orchestrator.runs WHERE run_id=$1', [id])).rows[0]?.record ?? null,
        save: row => query(`INSERT INTO bairui_orchestrator.runs(run_id,record) VALUES($1,$2::jsonb)
          ON CONFLICT(run_id) DO UPDATE SET record=EXCLUDED.record,touched_at=clock_timestamp()`, [id, JSON.stringify(row)]),
      });
    } finally {
      if (locked && !broken) {
        try { if (!(await query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked', [key])).rows[0].unlocked) broken = true; }
        catch { broken = true; }
      }
      client.removeListener('error', onError);
      client.release(broken);
    }
  }
  async list(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('batch_invalid');
    return (await this.pool.query(`SELECT run_id FROM bairui_orchestrator.runs
      WHERE record->>'phase' NOT IN ('stopped','absent') ORDER BY touched_at,run_id LIMIT $1`, [limit])).rows.map(row => row.run_id);
  }
  async consume(keyId, nonce, expiresAt, now) {
    await this.pool.query('DELETE FROM bairui_orchestrator.nonces WHERE expires_at < $1', [now]);
    return (await this.pool.query(`INSERT INTO bairui_orchestrator.nonces(key_id,nonce,expires_at)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce`, [keyId, nonce, expiresAt])).rowCount === 1;
  }
}
