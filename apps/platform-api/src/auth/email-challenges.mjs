import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { rollbackForRelease } from '../postgres-transaction.mjs';

const digest = token => createHash('sha256').update(token).digest('hex');
export const isMailToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
  && Buffer.from(token, 'base64url').toString('base64url') === token;

export async function authTransaction(pool, operation) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    releaseError = await rollbackForRelease(client);
    throw error;
  } finally { client.release(releaseError); }
}

export async function lockAuthIdentity(client, userId) {
  // Exact lock used by 036/037 before creating or revoking this identity's sessions.
  const lock = await client.query(`
    SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      pg_catalog.quote_ident(n.nspname) || ':governance:session:' || $1, 0))
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = pg_catalog.to_regclass('ba_session')`, [userId]);
  if (lock.rowCount !== 1) throw new Error('auth_email_state_invalid');
}

const credentialExists = `EXISTS (SELECT 1 FROM ba_account a WHERE a."userId" = u.id
  AND a."accountId" = u.id AND a."providerId" = 'credential' AND a.password IS NOT NULL)`;

export function emailChallenges(pool, origin, secret) {
  return {
    async ready() {
      await pool.query('SELECT auth_user_id, purpose, email, token_digest, issued_at, expires_at, consumed_at FROM ba_email_challenge LIMIT 0');
      return true;
    },
    async limit(path, ip, max, windowMs = 60000) {
      const key = 'platform-mail:' + createHmac('sha256', secret).update(JSON.stringify([path, ip])).digest('hex');
      const result = await pool.query(`
        INSERT INTO ba_rate_limit (id, key, count, "lastRequest")
        VALUES ($1, $2, 1, floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint)
        ON CONFLICT (key) DO UPDATE
        SET count = CASE WHEN ba_rate_limit."lastRequest" + $4::bigint <= EXCLUDED."lastRequest" THEN 1 ELSE ba_rate_limit.count + 1 END,
            "lastRequest" = greatest(ba_rate_limit."lastRequest", EXCLUDED."lastRequest")
        WHERE ba_rate_limit."lastRequest" + $4::bigint <= EXCLUDED."lastRequest" OR ba_rate_limit.count < $3
        RETURNING count`, [randomUUID(), key, max, windowMs]);
      return result.rowCount === 1;
    },
    async issue({ kind, authId, email }) {
      return authTransaction(pool, async client => {
        const id = authId ?? (await client.query('SELECT id FROM ba_user WHERE email = $1', [email])).rows[0]?.id;
        if (!id) return null;
        await lockAuthIdentity(client, id);
        const { rows: [user] } = await client.query(`
          SELECT u.id, u.email, u."emailVerified", platform_account_session_allowed(u.id) AS allowed
          FROM ba_user u WHERE u.id = $1 AND ${credentialExists}`, [id]);
        if (!user?.allowed || (kind === 'verify' ? user.emailVerified : !user.emailVerified || user.email !== email)) return null;
        const token = randomBytes(32).toString('base64url');
        const ttl = kind === 'verify' ? 86400 : 1800;
        const inserted = await client.query(`
          INSERT INTO ba_email_challenge (auth_user_id, purpose, email, token_digest, issued_at, expires_at)
          VALUES ($1, $2, $3, $4, statement_timestamp(), statement_timestamp() + $5 * interval '1 second')
          ON CONFLICT (auth_user_id, purpose) DO UPDATE SET email = EXCLUDED.email,
            token_digest = EXCLUDED.token_digest, issued_at = EXCLUDED.issued_at, expires_at = EXCLUDED.expires_at,
            consumed_at = NULL
          WHERE ba_email_challenge.issued_at <= EXCLUDED.issued_at - interval '60 seconds'
          RETURNING auth_user_id`, [id, kind, user.email, digest(token), ttl]);
        if (!inserted.rowCount) return null;
        return { kind, to: user.email, link: origin + '/auth/' + kind + '#token=' + token };
      });
    },
    async confirm(kind, token, newPassword) {
      const hash = digest(token);
      const { rows: [candidate] } = await pool.query(`
        SELECT auth_user_id FROM ba_email_challenge WHERE token_digest = $1 AND purpose = $2
          AND consumed_at IS NULL AND expires_at > statement_timestamp()`, [hash, kind]);
      if (!candidate) return false;
      // Expensive hashing stays outside the lock; eligibility is rechecked under it.
      const passwordHash = kind === 'reset' ? await hashPassword(newPassword) : null;
      return authTransaction(pool, async client => {
        const id = candidate.auth_user_id;
        await lockAuthIdentity(client, id);
        const { rows: [user] } = await client.query(`
          SELECT u."emailVerified", platform_account_session_allowed(u.id) AS allowed
          FROM ba_email_challenge c JOIN ba_user u ON u.id = c.auth_user_id AND u.email = c.email
          WHERE c.auth_user_id = $1 AND c.purpose = $2 AND c.token_digest = $3
            AND c.consumed_at IS NULL AND c.expires_at > statement_timestamp() AND ${credentialExists}`, [id, kind, hash]);
        if (!user?.allowed || (kind === 'verify' ? user.emailVerified : !user.emailVerified)) return false;
        const result = kind === 'verify'
          ? await client.query('UPDATE ba_user SET "emailVerified" = true, "updatedAt" = statement_timestamp() WHERE id = $1', [id])
          : await client.query(`UPDATE ba_account SET password = $2, "updatedAt" = statement_timestamp()
              WHERE "userId" = $1 AND "accountId" = $1 AND "providerId" = 'credential'`, [id, passwordHash]);
        if (result.rowCount !== 1) throw new Error('auth_email_state_invalid');
        // A pre-verification cookie must not regain access when the email
        // flips to verified. Both transitions require a fresh sign-in.
        await client.query('DELETE FROM ba_session WHERE "userId" = $1', [id]);
        await client.query(`UPDATE ba_email_challenge SET consumed_at = statement_timestamp()
          WHERE auth_user_id = $1 AND purpose = $2`, [id, kind]);
        return true;
      });
    },
  };
}
