-- Step 1: Create the providers table
CREATE TABLE IF NOT EXISTS "providers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- Step 2: Create unique index on name
CREATE UNIQUE INDEX IF NOT EXISTS "providers_name_key" ON "providers"("name");

-- Step 3: Insert known provider values
INSERT INTO "providers" ("name") VALUES ('claude-code') ON CONFLICT ("name") DO NOTHING;
INSERT INTO "providers" ("name") VALUES ('open-code') ON CONFLICT ("name") DO NOTHING;

-- Step 4: agent_templates – rename existing integer column
ALTER TABLE "agent_templates" RENAME COLUMN "default_provider" TO "default_provider_id";

-- Step 5: agents – rename existing integer column
ALTER TABLE "agents" RENAME COLUMN "provider" TO "provider_id";
