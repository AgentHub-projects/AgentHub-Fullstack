-- EnableExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "session_status" AS ENUM ('active', 'archived', 'deleted');

-- CreateEnum
CREATE TYPE "message_role" AS ENUM ('user', 'assistant', 'agent', 'system', 'tool');

-- CreateEnum
CREATE TYPE "run_status" AS ENUM ('queued', 'context_building', 'connecting', 'running', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "agent_status" AS ENUM ('enabled', 'disabled', 'offline', 'error');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('queued', 'thinking', 'streaming', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "artifact_kind" AS ENUM ('markdown', 'text', 'html', 'pdf', 'docx', 'image', 'archive', 'log', 'other');

-- CreateEnum
CREATE TYPE "storage_kind" AS ENUM ('inline_text', 'oss_object', 'remote_url');

-- CreateEnum
CREATE TYPE "file_change_type" AS ENUM ('added', 'modified', 'deleted', 'renamed');

-- CreateEnum
CREATE TYPE "context_item_kind" AS ENUM ('message', 'artifact', 'file_change', 'run_summary', 'manual_pin');

-- CreateTable
CREATE TABLE "agent_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "agent_kind" TEXT NOT NULL DEFAULT 'worker',
    "system_prompt" TEXT NOT NULL DEFAULT '',
    "prompt_config" JSONB NOT NULL DEFAULT '{}',
    "default_capabilities" JSONB NOT NULL DEFAULT '[]',
    "default_model_config" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "agent_status" NOT NULL DEFAULT 'enabled',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "provider" INTEGER NOT NULL DEFAULT 0,
    "is_default_orchestrator" BOOLEAN NOT NULL DEFAULT false,
    "status" "agent_status" NOT NULL DEFAULT 'offline',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled Session',
    "status" "session_status" NOT NULL DEFAULT 'active',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_agents" (
    "session_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "participant_role" TEXT NOT NULL DEFAULT 'member',
    "source" TEXT NOT NULL DEFAULT 'mention',
    "first_mentioned_at" TIMESTAMPTZ(6),
    "last_active_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_agents_pkey" PRIMARY KEY ("session_id","agent_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "run_id" UUID,
    "role" "message_role" NOT NULL,
    "agent_id" UUID,
    "parent_message_id" UUID,
    "content_text" TEXT NOT NULL DEFAULT '',
    "content_json" JSONB NOT NULL DEFAULT '{}',
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "status" "message_status" NOT NULL DEFAULT 'completed',
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_snapshots" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "run_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "token_budget" INTEGER NOT NULL,
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "selected_item_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "snapshot_json" JSONB NOT NULL,
    "prompt_text" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "orchestrator_agent_id" UUID NOT NULL,
    "user_message_id" UUID,
    "assistant_message_id" UUID,
    "context_snapshot_id" UUID,
    "status" "run_status" NOT NULL DEFAULT 'queued',
    "downstream_session_id" TEXT,
    "downstream_run_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "usage_json" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'downstream_agent',
    "event_type" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "speaker_agent_id" UUID,
    "speaker_name" TEXT,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6),
    "persisted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "run_id" UUID,
    "producing_event_id" UUID,
    "artifact_key" TEXT,
    "kind" "artifact_kind" NOT NULL,
    "title" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "storage_kind" "storage_kind" NOT NULL DEFAULT 'inline_text',
    "storage_uri" TEXT,
    "text_content" TEXT,
    "sha256" TEXT,
    "size_bytes" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "final" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_changes" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "artifact_id" UUID,
    "producing_event_id" UUID,
    "path" TEXT NOT NULL,
    "old_path" TEXT,
    "change_type" "file_change_type" NOT NULL,
    "language" TEXT,
    "before_content" TEXT,
    "before_sha256" TEXT,
    "before_truncated" BOOLEAN NOT NULL DEFAULT false,
    "after_content" TEXT,
    "after_sha256" TEXT,
    "after_truncated" BOOLEAN NOT NULL DEFAULT false,
    "patch" TEXT,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_items" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID,
    "kind" "context_item_kind" NOT NULL,
    "text" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "importance" INTEGER NOT NULL DEFAULT 0,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "context_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_embeddings" (
    "id" UUID NOT NULL,
    "context_item_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "dims" INTEGER NOT NULL DEFAULT 1536,
    "embedding" vector(1536) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_update_jobs" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "context_update_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "long_term_summaries" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "long_term_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_agent_templates_kind" ON "agent_templates"("agent_kind");

-- CreateIndex
CREATE UNIQUE INDEX "agents_name_key" ON "agents"("name");

-- CreateIndex
CREATE INDEX "idx_agents_template" ON "agents"("template_id");

-- CreateIndex
CREATE INDEX "idx_agents_default_orchestrator" ON "agents"("is_default_orchestrator");

-- CreateIndex
CREATE INDEX "idx_sessions_updated_at" ON "sessions"("updated_at" DESC);

-- CreateIndex
CREATE INDEX "idx_messages_session_created" ON "messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_messages_pinned" ON "messages"("session_id", "is_pinned");

-- CreateIndex
CREATE INDEX "idx_messages_status" ON "messages"("session_id", "status");

-- CreateIndex
CREATE INDEX "idx_agent_runs_session_created" ON "agent_runs"("session_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_agent_runs_status" ON "agent_runs"("status");

-- CreateIndex
CREATE INDEX "idx_agent_events_run_seq" ON "agent_events"("run_id", "seq");

-- CreateIndex
CREATE INDEX "idx_agent_events_session_persisted" ON "agent_events"("session_id", "persisted_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_events_run_id_seq_key" ON "agent_events"("run_id", "seq");

-- CreateIndex
CREATE INDEX "idx_artifacts_session_updated" ON "artifacts"("session_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_run_id_artifact_key_key" ON "artifacts"("run_id", "artifact_key");

-- CreateIndex
CREATE INDEX "idx_file_changes_run_path" ON "file_changes"("run_id", "path");

-- CreateIndex
CREATE INDEX "idx_context_items_session_kind" ON "context_items"("session_id", "kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_context_items_pinned" ON "context_items"("session_id", "pinned");

-- CreateIndex
CREATE INDEX "idx_context_embeddings_session" ON "context_embeddings"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "context_embeddings_context_item_id_model_key" ON "context_embeddings"("context_item_id", "model");

-- CreateIndex
CREATE INDEX "idx_long_term_summaries_session_seq" ON "long_term_summaries"("session_id", "seq");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "agent_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_agents" ADD CONSTRAINT "session_agents_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_agents" ADD CONSTRAINT "session_agents_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_snapshots" ADD CONSTRAINT "context_snapshots_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_orchestrator_agent_id_fkey" FOREIGN KEY ("orchestrator_agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_speaker_agent_id_fkey" FOREIGN KEY ("speaker_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_changes" ADD CONSTRAINT "file_changes_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_changes" ADD CONSTRAINT "file_changes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_changes" ADD CONSTRAINT "file_changes_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_items" ADD CONSTRAINT "context_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_embeddings" ADD CONSTRAINT "context_embeddings_context_item_id_fkey" FOREIGN KEY ("context_item_id") REFERENCES "context_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_embeddings" ADD CONSTRAINT "context_embeddings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_update_jobs" ADD CONSTRAINT "context_update_jobs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "long_term_summaries" ADD CONSTRAINT "long_term_summaries_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
