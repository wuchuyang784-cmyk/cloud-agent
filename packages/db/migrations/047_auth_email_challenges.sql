-- Requires 032 and the 036 session-identity guard. No backfill of verified email.
BEGIN;

CREATE TABLE IF NOT EXISTS ba_email_challenge (
  auth_user_id text NOT NULL REFERENCES ba_user(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  email text NOT NULL,
  token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
  consumed_at timestamptz,
  PRIMARY KEY (auth_user_id, purpose)
);

REVOKE ALL ON ba_email_challenge FROM PUBLIC;
COMMIT;
