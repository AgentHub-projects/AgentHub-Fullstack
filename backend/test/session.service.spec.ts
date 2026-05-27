import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentRun } from "@agenthub/shared";
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

  it("rejects cancel for an unknown run ID with RUN_NOT_FOUND", () => {
    const runner = { run: vi.fn(), cancel: vi.fn() } as unknown as AgentRunner;
    const worktrees = { prepare: vi.fn(), complete: vi.fn() } as unknown as WorktreeService;
    const gateway = { emitAgentEvent: vi.fn((_event: AgentEvent) => undefined) } as never;
    const service = new SessionService(runner, worktrees, gateway);

    expectApiError(() => service.cancel("run-missing"), {
      response: { code: "RUN_NOT_FOUND", message: "Run run-missing was not found." },
      status: 404
    });
  });

  it("rejects cancel for a non-running run with RUN_NOT_ACTIVE", async () => {
    const runner = {
      run: vi.fn(async () => ({
        output: "done",
        summary: "# Summary\n"
      })),
      cancel: vi.fn()
    } as unknown as AgentRunner;
    const worktrees = {
      prepare: vi.fn(async () => ({
        repoPath: "repo",
        branchName: "agent/run-complete/main",
        worktreePath: "worktree",
        summaryPath: "summary.md",
        logPath: "agent.log"
      })),
      complete: vi.fn(async () => ({
        status: "synced",
        targetBranch: "main"
      }))
    } as unknown as WorktreeService;
    const gateway = {
      emitAgentEvent: vi.fn((_event: AgentEvent) => undefined)
    } as never;
    const service = new SessionService(runner, worktrees, gateway);

    const started = await service.run({ prompt: "complete me" });
    await waitFor(() => service.getCurrentSession().status === "succeeded");

    expectApiError(() => service.cancel(started.run.id), {
      response: { code: "RUN_NOT_ACTIVE", message: `Run ${started.run.id} is not active.` },
      status: 409
    });
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
  it("accepts direct mode with an explicit single agentIds value", async () => {
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

    const result = await service.run({ prompt: "direct task", agentIds: ["claude"], mode: "direct" });
    expect(result.session.agentIds).toEqual(["claude"]);
    expect(result.session.mode).toBe("direct");
    expect(result.run.agentId).toBe("claude");
  });

  it("runs group mode agents serially in agentIds order", async () => {
    const run = vi.fn(async ({ run: agentRun }: { run: AgentRun }) => ({
      output: `${agentRun.agentId} completed`,
      summary: `# ${agentRun.agentId}\n`
    }));
    const runner = {
      run,
      cancel: vi.fn()
    } as unknown as AgentRunner;
    const worktrees = {
      prepare: vi.fn(async (runId: string) => ({
        repoPath: "repo",
        branchName: `agent/${runId}/main`,
        worktreePath: `worktree-${runId}`,
        summaryPath: "summary.md",
        logPath: "agent.log"
      })),
      complete: vi.fn(async () => ({
        status: "synced",
        targetBranch: "main"
      }))
    } as unknown as WorktreeService;
    const gateway = {
      emitAgentEvent: vi.fn((_event: AgentEvent) => undefined)
    } as never;
    const service = new SessionService(runner, worktrees, gateway);

    const result = await service.run({ prompt: "group task", agentIds: ["claude", "claude-code"], mode: "group" });

    expect(result.session.agentIds).toEqual(["claude", "claude-code"]);
    expect(result.session.mode).toBe("group");
    expect(result.session.runIds).toHaveLength(2);
    expect(result.run.agentId).toBe("claude");

    await waitFor(() => service.getCurrentSession().status === "succeeded");

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map(([context]) => context.run.agentId)).toEqual(["claude", "claude-code"]);
    expect(worktrees.prepare).toHaveBeenCalledTimes(2);
  });

  it("does not start the second group agent after the first run is cancelled", async () => {
    const run = vi.fn(
      () =>
        new Promise(() => {
          return undefined;
        })
    );
    const runner = {
      run,
      cancel: vi.fn(() => true)
    } as unknown as AgentRunner;
    const worktrees = {
      prepare: vi.fn(async (runId: string) => ({
        repoPath: "repo",
        branchName: `agent/${runId}/main`,
        worktreePath: `worktree-${runId}`,
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
    service.cancelCurrent();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runner.cancel).toHaveBeenCalledWith(result.run.id);
    expect(service.getCurrentSession().status).toBe("idle");
    expect(run).toHaveBeenCalledTimes(1);
    expect(worktrees.prepare).toHaveBeenCalledTimes(1);
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
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for predicate");
}

function expectApiError(fn: () => unknown, expected: object): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject(expected);
}
