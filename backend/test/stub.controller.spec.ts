import { describe, expect, it, vi } from "vitest";
import { StubController } from "../src/controllers/stub.controller";

describe("StubController", () => {
  it("lists agents from AgentDefinition records", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "claude",
        name: "Claude",
        provider: "anthropic",
        role: "coding-agent",
        description: "Anthropic Claude - general-purpose coding agent",
        createdAt: new Date("2026-05-27T00:00:00Z")
      },
      {
        id: "claude-code",
        name: "Claude Code",
        provider: "local-cli",
        role: "coding-agent",
        description: "Local Claude Code CLI agent",
        createdAt: new Date("2026-05-27T00:00:01Z")
      }
    ]);
    const prisma = {
      agentDefinition: {
        findMany
      }
    };
    const controller = new StubController(prisma as never);

    await expect(controller.listAgents()).resolves.toEqual({
      items: [
        {
          id: "claude",
          name: "Claude",
          provider: "anthropic",
          role: "coding-agent",
          description: "Anthropic Claude - general-purpose coding agent"
        },
        {
          id: "claude-code",
          name: "Claude Code",
          provider: "local-cli",
          role: "coding-agent",
          description: "Local Claude Code CLI agent"
        }
      ]
    });
    expect(findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
  });
});
