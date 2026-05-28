-- Add multi-agent session metadata without changing the initial migration.
ALTER TABLE "Session"
  ADD COLUMN "agentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'direct';

UPDATE "Session"
SET "agentIds" = ARRAY["agentId"]
WHERE "agentId" IS NOT NULL
  AND cardinality("agentIds") = 0;
