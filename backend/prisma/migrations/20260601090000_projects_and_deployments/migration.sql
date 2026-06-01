ALTER TABLE "sessions" ADD COLUMN "project_id" UUID;

CREATE TABLE "projects" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "github_url" TEXT NOT NULL,
  "default_branch" TEXT NOT NULL DEFAULT 'main',
  "status" TEXT NOT NULL DEFAULT 'active',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "deployments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "session_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "trigger_message_id" UUID,
  "commit_sha" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "deploy_service_job_id" TEXT,
  "url" TEXT,
  "error_message" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_sessions_project_id" ON "sessions"("project_id");
CREATE INDEX "idx_projects_status_updated" ON "projects"("status", "updated_at" DESC);
CREATE INDEX "idx_deployments_session_created" ON "deployments"("session_id", "created_at" DESC);
CREATE INDEX "idx_deployments_project_created" ON "deployments"("project_id", "created_at" DESC);

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "deployments"
  ADD CONSTRAINT "deployments_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "deployments"
  ADD CONSTRAINT "deployments_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
