-- AGE-6 durable fact source. This migration assumes the AGE-3 base
-- Session/AgentRun/AgentEvent/Artifact tables already exist.

ALTER TABLE "AgentEvent" ADD CONSTRAINT "AgentEvent_runId_seq_key" UNIQUE ("runId", "seq");
CREATE INDEX "AgentEvent_runId_seq_idx" ON "AgentEvent"("runId", "seq");

CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'assistant',
    "status" TEXT NOT NULL DEFAULT 'streaming',
    "content" TEXT NOT NULL DEFAULT '',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FileChange" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'modified',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "diff" TEXT,
    "sha256" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileChange_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Artifact" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "Artifact" ADD COLUMN "sha256" TEXT;
ALTER TABLE "Artifact" ADD COLUMN "byteLength" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Artifact" ADD COLUMN "chunkCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Artifact" ADD COLUMN "storageProvider" TEXT;
ALTER TABLE "Artifact" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "Artifact" ADD COLUMN "metadata" JSONB;
ALTER TABLE "Artifact" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Artifact" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ArtifactChunk" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "sha256" TEXT,
    "byteLength" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtifactChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContextItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "source" TEXT,
    "embedding" JSONB,
    "embeddingProvider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Message_runId_createdAt_idx" ON "Message"("runId", "createdAt");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX "FileChange_runId_path_idx" ON "FileChange"("runId", "path");
CREATE INDEX "Artifact_runId_createdAt_idx" ON "Artifact"("runId", "createdAt");
CREATE UNIQUE INDEX "ArtifactChunk_artifactId_index_key" ON "ArtifactChunk"("artifactId", "index");
CREATE INDEX "ArtifactChunk_runId_artifactId_idx" ON "ArtifactChunk"("runId", "artifactId");
CREATE INDEX "ContextItem_conversationId_createdAt_idx" ON "ContextItem"("conversationId", "createdAt");
CREATE INDEX "ContextItem_runId_createdAt_idx" ON "ContextItem"("runId", "createdAt");

ALTER TABLE "Message" ADD CONSTRAINT "Message_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FileChange" ADD CONSTRAINT "FileChange_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ArtifactChunk" ADD CONSTRAINT "ArtifactChunk_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContextItem" ADD CONSTRAINT "ContextItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
