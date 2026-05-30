-- Destructively rebuild local Agent ids from UUID to integer ids.
-- The local session/run/message/event data is intentionally cleared instead of
-- preserving UUID mappings.

TRUNCATE TABLE
  "file_changes",
  "artifacts",
  "agent_events",
  "messages",
  "context_snapshots",
  "context_embeddings",
  "context_items",
  "context_update_jobs",
  "long_term_summaries",
  "session_agents",
  "agent_runs",
  "sessions",
  "agents"
RESTART IDENTITY CASCADE;

ALTER TABLE "session_agents" DROP CONSTRAINT IF EXISTS "session_agents_agent_id_fkey";
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_agent_id_fkey";
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_orchestrator_agent_id_fkey";
ALTER TABLE "agent_events" DROP CONSTRAINT IF EXISTS "agent_events_speaker_agent_id_fkey";

ALTER TABLE "session_agents" DROP CONSTRAINT IF EXISTS "session_agents_pkey";
ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_pkey";

ALTER TABLE "agents" DROP COLUMN "id";
DROP SEQUENCE IF EXISTS "agents_id_seq";
CREATE SEQUENCE "agents_id_seq";
ALTER TABLE "agents" ADD COLUMN "id" INTEGER NOT NULL DEFAULT nextval('"agents_id_seq"');
ALTER SEQUENCE "agents_id_seq" OWNED BY "agents"."id";
ALTER TABLE "agents" ADD CONSTRAINT "agents_pkey" PRIMARY KEY ("id");

ALTER TABLE "session_agents" DROP COLUMN "agent_id";
ALTER TABLE "session_agents" ADD COLUMN "agent_id" INTEGER NOT NULL;
ALTER TABLE "session_agents" ADD CONSTRAINT "session_agents_pkey" PRIMARY KEY ("session_id", "agent_id");

ALTER TABLE "messages" DROP COLUMN "agent_id";
ALTER TABLE "messages" ADD COLUMN "agent_id" INTEGER;

ALTER TABLE "agent_runs" DROP COLUMN "orchestrator_agent_id";
ALTER TABLE "agent_runs" ADD COLUMN "orchestrator_agent_id" INTEGER NOT NULL;

ALTER TABLE "agent_events" DROP COLUMN "speaker_agent_id";
ALTER TABLE "agent_events" ADD COLUMN "speaker_agent_id" INTEGER;

ALTER TABLE "session_agents"
  ADD CONSTRAINT "session_agents_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_orchestrator_agent_id_fkey"
  FOREIGN KEY ("orchestrator_agent_id") REFERENCES "agents"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_events"
  ADD CONSTRAINT "agent_events_speaker_agent_id_fkey"
  FOREIGN KEY ("speaker_agent_id") REFERENCES "agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
