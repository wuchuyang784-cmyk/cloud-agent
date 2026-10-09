-- Dedicated orchestrator database ONLY. Never run in the platform business DB.
CREATE SCHEMA bairui_orchestrator;
REVOKE ALL ON SCHEMA bairui_orchestrator FROM PUBLIC;
CREATE TABLE bairui_orchestrator.installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  installation_id text NOT NULL CHECK(installation_id ~ '^[a-z0-9-]{8,48}$')
);
CREATE TABLE bairui_orchestrator.runs (
  run_id text PRIMARY KEY,
  record jsonb NOT NULL,
  touched_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX orchestrator_pending ON bairui_orchestrator.runs(touched_at)
  WHERE record->>'phase' NOT IN ('stopped','absent');
CREATE TABLE bairui_orchestrator.nonces (
  key_id text NOT NULL, nonce text NOT NULL, expires_at bigint NOT NULL,
  PRIMARY KEY(key_id, nonce)
);
REVOKE ALL ON ALL TABLES IN SCHEMA bairui_orchestrator FROM PUBLIC;
-- DBA inserts one installation_id then grants schema USAGE, installation SELECT,
-- runs SELECT/INSERT/UPDATE and nonces SELECT/INSERT/DELETE to a dedicated login.
-- No application auto-migration or tombstone deletion permission.
