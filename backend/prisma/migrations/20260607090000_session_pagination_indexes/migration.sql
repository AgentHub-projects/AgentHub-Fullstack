CREATE INDEX IF NOT EXISTS "idx_sessions_status_updated_id"
  ON "sessions" ("status", "updated_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_messages_session_created_desc_id"
  ON "messages" ("session_id", "created_at" DESC, "id" DESC);
