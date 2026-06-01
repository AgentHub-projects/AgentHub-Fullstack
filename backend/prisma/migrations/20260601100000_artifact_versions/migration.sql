CREATE TABLE "artifact_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "artifact_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "producing_event_id" UUID,
  "title" TEXT NOT NULL,
  "kind" "artifact_kind" NOT NULL,
  "mime_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
  "storage_kind" "storage_kind" NOT NULL DEFAULT 'inline_text',
  "storage_uri" TEXT,
  "text_content" TEXT,
  "sha256" TEXT,
  "size_bytes" BIGINT,
  "final" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifact_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "artifact_versions_artifact_id_version_key" ON "artifact_versions"("artifact_id", "version");
CREATE INDEX "idx_artifact_versions_artifact_version" ON "artifact_versions"("artifact_id", "version" DESC);

ALTER TABLE "artifact_versions"
  ADD CONSTRAINT "artifact_versions_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
