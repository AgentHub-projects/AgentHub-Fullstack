-- AlterTable
ALTER TABLE "agent_templates"
  ALTER COLUMN "default_provider" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "agents"
  ALTER COLUMN "provider" SET DATA TYPE TEXT;
