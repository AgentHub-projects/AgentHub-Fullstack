import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentRun } from "@agenthub/shared";
import { AgentEventsGateway } from "../src/realtime/agent-events.gateway";
import { AgentRunner, type RunnerContext } from "../src/services/agent-runner.service";
import { EventStore } from "../src/services/event-store.service";
import { PrismaFactSourceRepository } from "../src/services/prisma-fact-source.repository";
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
      emitAgentEvent: vi.fn(async (_event: AgentEvent) => undefined)
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
      emitAgentEvent: vi.fn(async (_event: AgentEvent) => undefined)
    } as never;
    const service = new SessionService(runner, worktrees, gateway);

    const started = await service.run({ prompt: "cancel me" });
    const cancelled = await service.cancelCurrent();

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
      emitAgentEvent: vi.fn(async (_event: AgentEvent) => undefined)
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

  it("persists Session and AgentRun rows before live gateway events reach Prisma", async () => {
    const prisma = new RecordingPrisma();
    const repository = new PrismaFactSourceRepository(prisma as never);
    const eventStore = new EventStore(repository);
    const gateway = new AgentEventsGateway(eventStore);
    const runner = {
      run: vi.fn(async (context: RunnerContext) => {
        await context.emit({
          type: "text_delta",
          runId: context.run.id,
          conversationId: context.run.conversationId,
          agentId: context.run.agentId,
          payload: { text: "persisted output" }
        });
        return {
          output: "persisted output",
          summary: "# Summary\n"
        };
      }),
      cancel: vi.fn()
    } as unknown as AgentRunner;
    const worktrees = {
      prepare: vi.fn(async () => ({
        repoPath: "repo",
        branchName: "agent/run-004/main",
        worktreePath: "worktree",
        summaryPath: "summary.md",
        logPath: "agent.log"
      })),
      complete: vi.fn(async () => ({
        status: "synced",
        targetBranch: "main",
        commitSha: "abc123"
      }))
    } as unknown as WorktreeService;
    const service = new SessionService(runner, worktrees, gateway, eventStore);

    const started = await service.run({ prompt: "persist me" });
    await waitFor(() => service.getCurrentSession().status === "succeeded");

    const firstEventIndex = prisma.operations.findIndex((operation) => operation === "agentEvent.create:agent_started");
    expect(firstEventIndex).toBeGreaterThan(-1);
    expect(prisma.operations.indexOf("session.upsert:session-current")).toBeLessThan(firstEventIndex);
    expect(prisma.operations.indexOf(`agentRun.upsert:${started.run.id}`)).toBeLessThan(firstEventIndex);
    expect(prisma.agentRuns.get(started.run.id)).toMatchObject({
      id: started.run.id,
      sessionId: "session-current",
      status: "succeeded",
      prompt: "persist me"
    });
    expect(prisma.events).toHaveLength(4);
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

class RecordingPrisma {
  readonly operations: string[] = [];
  readonly sessions = new Map<string, any>();
  readonly agentRuns = new Map<string, any>();
  readonly events: any[] = [];
  readonly messages = new Map<string, any>();

  readonly session = {
    upsert: async (args: any) => {
      this.operations.push(`session.upsert:${args.where.id}`);
      const existing = this.sessions.get(args.where.id);
      const row = {
        ...(existing ?? {}),
        ...(existing ? args.update : args.create),
        id: args.where.id,
        createdAt: existing?.createdAt ?? args.create.createdAt ?? new Date(),
        updatedAt: new Date()
      };
      this.sessions.set(args.where.id, row);
      return row;
    }
  };

  readonly agentRun = {
    upsert: async (args: any) => {
      this.operations.push(`agentRun.upsert:${args.where.id}`);
      const data = this.compact(existingAwareData(this.agentRuns.get(args.where.id), args.update, args.create));
      const sessionId = String(data.sessionId);
      if (!this.sessions.has(sessionId)) {
        throw new Error(`Missing Session ${data.sessionId}`);
      }
      const row = {
        ...data,
        sessionId,
        id: args.where.id,
        createdAt: data.createdAt ?? new Date()
      };
      this.agentRuns.set(args.where.id, row);
      return row;
    }
  };

  readonly agentEvent = {
    create: async (args: any) => {
      this.operations.push(`agentEvent.create:${args.data.type}`);
      if (!this.agentRuns.has(args.data.runId)) {
        throw new Error(`Missing AgentRun ${args.data.runId}`);
      }
      this.events.push(args.data);
      return args.data;
    }
  };

  readonly message = {
    findUnique: async (args: any) => this.messages.get(args.where.id) ?? null,
    create: async (args: any) => {
      const now = new Date();
      const row = {
        ...args.data,
        createdAt: now,
        updatedAt: now,
        completedAt: args.data.completedAt
      };
      this.messages.set(args.data.id, row);
      return row;
    },
    update: async (args: any) => {
      const existing = this.messages.get(args.where.id);
      if (!existing) {
        throw new Error(`Missing Message ${args.where.id}`);
      }
      const row = {
        ...existing,
        ...this.compact(args.data),
        updatedAt: args.data.updatedAt ?? new Date()
      };
      this.messages.set(args.where.id, row);
      return row;
    }
  };

  async $transaction<T>(work: (tx: RecordingPrisma) => Promise<T>): Promise<T> {
    return work(this);
  }

  private compact(input: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  }
}

function existingAwareData(existing: any, update: any, create: any): Record<string, unknown> {
  return existing ? { ...existing, ...update } : create;
}
