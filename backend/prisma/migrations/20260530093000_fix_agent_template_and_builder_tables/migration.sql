-- Align agent_templates with the current Prisma model.
ALTER TABLE "agent_templates"
  ADD COLUMN IF NOT EXISTS "default_provider" INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS "idx_agent_templates_kind";

ALTER TABLE "agent_templates"
  DROP COLUMN IF EXISTS "agent_kind";

-- Add builder tables that are present in schema.prisma.
CREATE TABLE IF NOT EXISTS "build_sessions" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "context" JSONB NOT NULL DEFAULT '{}',
    "agent_template_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "build_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "build_messages" (
    "id" UUID NOT NULL,
    "build_session_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "build_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_build_messages_session_created"
  ON "build_messages"("build_session_id", "created_at");

DO $$
BEGIN
  ALTER TABLE "build_messages"
    ADD CONSTRAINT "build_messages_build_session_id_fkey"
    FOREIGN KEY ("build_session_id") REFERENCES "build_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
