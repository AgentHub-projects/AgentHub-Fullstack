import { HttpException } from "@nestjs/common";
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
});
