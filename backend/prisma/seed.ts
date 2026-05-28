/**
 * Prisma seed: inserts default agent definitions.
 *
 * Run via: prisma db seed
 * (configured in package.json under prisma.seed)
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEFAULT_AGENTS = [
  {
    id: "claude",
    name: "Claude",
    provider: "anthropic",
    role: "coding-agent",
    description: "Anthropic Claude – general-purpose coding agent"
  },
  {
    id: "claude-code",
    name: "Claude Code",
    provider: "local-cli",
    role: "coding-agent",
    description: "Local Claude Code CLI agent"
  }
];

async function main() {
  for (const agent of DEFAULT_AGENTS) {
    await prisma.agentDefinition.upsert({
      where: { id: agent.id },
      update: {},
      create: agent
    });
  }
  console.log("Seed complete. Default agents:", DEFAULT_AGENTS.map((a) => a.id).join(", "));
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
