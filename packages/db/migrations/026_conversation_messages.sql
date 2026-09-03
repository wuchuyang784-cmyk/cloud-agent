-- 会话对话消息持久化：user/assistant 消息正文入库，支撑历史回读。
-- 基线：001_platform_mvp.sql（sessions_projection 会话投影）。
-- 全部 IF NOT EXISTS，可重复执行。
BEGIN;

CREATE TABLE IF NOT EXISTS conversation_messages (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions_projection(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_messages_session_idx
  ON conversation_messages (organization_id, session_id, created_at, id);

CREATE INDEX IF NOT EXISTS conversation_messages_user_time_idx
  ON conversation_messages (organization_id, user_id, created_at DESC, id DESC);

ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_messages_user_scope ON conversation_messages;
CREATE POLICY conversation_messages_user_scope ON conversation_messages
  USING (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true))
  WITH CHECK (organization_id = current_setting('app.organization_id', true)
    AND user_id = current_setting('app.user_id', true));

COMMIT;
