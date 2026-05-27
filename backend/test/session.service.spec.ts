import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agenthub/shared";
import { AgentRunner } from "../src/services/agent-runner.service";
import { SessionService } from "../src/services/session.service";
import { WorktreeService } from "../src/services/worktree.service";

describe("SessionService", () => {
  it("rejects concurrent active runs with 409", async () => {
    const runner = {
      run: vi.fn(
        () =>
          new Promise(() => {
            return undefined;
          })
      ),
      cancel: vi.fn()
    } as unknown as AgentRunner;
    const worktrees = {
      prepare: vi.fn(async () => ({
        repoPath: "repo",
        branchName: "agent/run-001/main",
        worktreePath: "worktree",
        summaryPath: "summary.md",
        logPath: "agent.log"
      })),
      complete: vi.fn()
    } as unknown as WorktreeService;
    const gateway = {
      emitAgentEvent: vi.fn((_event: AgentEvent) => undefined)
    } as never;
    const service = new SessionService(runner, worktrees, gateway);

    await service.run({ prompt: "first" });
    await expect(service.run({ prompt: "second" })).rejects.toMatchObject({
      response: {
        code: "ACTIVE_RUN_EXISTS"
      },
      status: 409
    });
  });

  it("cancels the current active run through the P0 compatibility path", async () => {
    const runner = {
      run: vi.fn(
        () =>
          new Promise(() => {
            return undefined;
          })
      ),
      cancel: vi.fn(() => true)
    } as unknown as AgentRunner;
    const worktrees = {
      prepare: vi.fn(async () => ({
        repoPath: "repo",
        branchName: "agent/run-002/main",
        worktreePath: "worktree",
        summaryPath: "summary.md",
        logPath: "agent.log"
      })),
      complete: vi.fn()
    } as unknown as WorktreeService;
    const gateway = {
      emitAgentEvent: vi.fn((_event: AgentEvent) => undefined)
    } as never;
    const service = new SessionService(runner, worktrees, gateway);

    const started = await service.run({ prompt: "cancel me" });
    const cancelled = service.cancelCurrent();

    expect(cancelled.run.id).toBe(started.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.session.status).toBe("idle");
    expect(runner.cancel).toHaveBeenCalledWith(started.run.id);
  });

  it("fails the run with TEST_SYNC_FAILED when sync fails", async () => {
    const runner = {
      run: vi.fn(async () => ({
        output: "agent completed",
        summary: "# Summary\n"
      })),
      cancel: vi.fn()
    } as unknown as AgentRunner;
    const worktrees = {
      prepare: vi.fn(async () => ({
        repoPath: "repo",
        branchName: "agent/run-003/main",
        worktreePath: "worktree",
        summaryPath: "summary.md",
        logPath: "agent.log"
      })),
      complete: vi.fn(async () => ({
        status: "failed",
        targetBranch: "main",
        error: {
          code: "TEST_SYNC_FAILED",
          message: "merge conflict"
        }
      }))
    } as unknown as WorktreeService;
    const gateway = {
      emitAgentEvent: vi.fn((_event: AgentEvent) => undefined)
    } as never;
    const service = new SessionService(runner, worktrees, gateway);

    await service.run({ prompt: "sync fail" });
    await waitFor(() => service.getCurrentSession().status !== "running");

    const session = service.getCurrentSession();
    expect(session.status).toBe("failed");
    expect(session.error).toBe("merge conflict");
    expect(session.output).toBe("agent completed");
    expect(session.testSync).toMatchObject({
      status: "failed",
      error: {
        code: "TEST_SYNC_FAILED",
        message: "merge conflict"
      }
    });
  });
  it("accepts agentIds and mode in the run request", async () => {
    const runner = {
      run: vi.fn(
        () =>
          new Promise(() => {
            return undefined;
          })
      ),
      cancel: vi.fn()
    } as unknown as AgentRunner;
    const worktrees = {
      prepare: vi.fn(async () => ({
        repoPath: "repo",
        branchName: "agent/run-multi/main",
        worktreePath: "worktree",
        summaryPath: "summary.md",
        logPath: "agent.log"
      })),
      complete: vi.fn()
    } as unknown as WorktreeService;
    const gateway = {
      emitAgentEvent: vi.fn((_event: AgentEvent) => undefined)
    } as never;
    const service = new SessionService(runner, worktrees, gateway);

    const result = await service.run({ prompt: "group task", agentIds: ["claude", "claude-code"], mode: "group" });
    expect(result.session.agentIds).toEqual(["claude", "claude-code"]);
    expect(result.session.mode).toBe("group");
    expect(result.run.agentId).toBe("claude");
  });

  it("rejects group mode with fewer than two agent IDs", async () => {
    const runner = { run: vi.fn(), cancel: vi.fn() } as unknown as AgentRunner;
    const worktrees = { prepare: vi.fn(), complete: vi.fn() } as unknown as WorktreeService;
    const gateway = { emitAgentEvent: vi.fn((_event: AgentEvent) => undefined) } as never;
    const service = new SessionService(runner, worktrees, gateway);

    await expect(service.run({ prompt: "solo", agentIds: ["claude"], mode: "group" })).rejects.toMatchObject({
      response: { code: "GROUP_REQUIRES_MULTIPLE_AGENTS" },
      status: 400
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for predicate");
}
