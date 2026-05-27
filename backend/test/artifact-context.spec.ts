import { describe, expect, it, vi } from "vitest";
import { StubController } from "../src/controllers/stub.controller";
import type { AgentEvent } from "@agenthub/shared";
import { AgentRunner } from "../src/services/agent-runner.service";
import { SessionService } from "../src/services/session.service";
import { WorktreeService } from "../src/services/worktree.service";

describe("Artifact integration", () => {
  it("stub artifacts endpoint returns a valid list structure", () => {
    const controller = new StubController();
    const result = controller.listArtifacts();
    expect(result).toHaveProperty("items");
    expect(Array.isArray(result.items)).toBe(true);
  });
});

describe("Context integration", () => {
  it("stub pinned-context supports create-then-read flow", () => {
    const controller = new StubController();
    const created = controller.createPinnedContext({ key: "rules", value: { format: "prettier" } });
    expect(created.item).toEqual({ key: "rules", value: { format: "prettier" } });

    const listed = controller.listPinnedContext();
    expect(listed).toHaveProperty("items");
  });
});

describe("Artifact and context end-to-end through a run lifecycle", () => {
  it("emits agent events with artifact-like payloads through the session", async () => {
    const emittedEvents: AgentEvent[] = [];
    const runner = {
      run: vi.fn(async () => ({
        output: "Generated files:\n- src/generated/todo.ts\n- src/generated/TodoList.tsx",
        summary: "# Artifacts\n\n- backend/src/generated/todo.ts\n- frontend/src/generated/TodoList.tsx\n",
      })),
      cancel: vi.fn(),
    } as unknown as AgentRunner;
    const worktrees = {
      prepare: vi.fn(async () => ({
        repoPath: "repo", branchName: "agent/test/main",
        worktreePath: "/tmp/worktree", summaryPath: "summary.md", logPath: "agent.log",
      })),
      complete: vi.fn(async () => ({
        status: "synced" as const, targetBranch: "main" as const,
        commitSha: "abc123", summaryPath: "summary.md",
      })),
    } as unknown as WorktreeService;
    const gateway = {
      emitAgentEvent: vi.fn((event: AgentEvent) => { emittedEvents.push(event); }),
    } as never;

    const service = new SessionService(runner, worktrees, gateway);
    await service.run({ prompt: "generate code" });
    await waitFor(() => service.getCurrentSession().status !== "running");

    const session = service.getCurrentSession();
    expect(session.status).toBe("succeeded");
    expect(session.output).toContain("Generated files");
    expect(session.testSync?.summaryPath).toBe("summary.md");

    const eventTypes = emittedEvents.map((e) => e.type);
    expect(eventTypes).toContain("agent_started");
    expect(eventTypes).toContain("agent_completed");
    expect(eventTypes).toContain("done");
  });
});

describe("Stub controller contract stability", () => {
  const controller = new StubController();

  it("all list endpoints return items array", () => {
    const endpoints = [
      { result: controller.listConversations(), name: "conversations" },
      { result: controller.listMessages("test-id"), name: "messages" },
      { result: controller.listAgents(), name: "agents" },
      { result: controller.listPinnedContext(), name: "pinned-context" },
      { result: controller.listArtifacts(), name: "artifacts" },
    ];

    for (const { result, name } of endpoints) {
      expect(result, `/${name} should have items`).toHaveProperty("items");
      expect(Array.isArray((result as { items: unknown[] }).items), `/${name} items should be array`).toBe(true);
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for predicate");
}
