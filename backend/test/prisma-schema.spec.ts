import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const backendRoot = join(__dirname, "..");

describe("Prisma schema", () => {
  it("keeps Session multi-agent fields in schema and additive migration", async () => {
    const [schema, migration] = await Promise.all([
      readFile(join(backendRoot, "prisma", "schema.prisma"), "utf8"),
      readFile(
        join(backendRoot, "prisma", "migrations", "20260527020000_session_multi_agent", "migration.sql"),
        "utf8"
      )
    ]);

    expect(schema).toContain("agentIds  String[] @default([])");
    expect(schema).toContain('mode      String   @default("direct")');
    expect(migration).toContain('ADD COLUMN "agentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]');
    expect(migration).toContain('ADD COLUMN "mode" TEXT NOT NULL DEFAULT \'direct\'');
  });
});
