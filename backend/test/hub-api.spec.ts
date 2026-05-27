import { describe, expect, it, vi } from "vitest";
import { HealthController } from "../src/controllers/health.controller";
import { SessionController } from "../src/controllers/session.controller";
import type { AgentEvent } from "@agenthub/shared";
import { AgentRunner } from "../src/services/agent-runner.service";
import { SessionService } from "../src/services/session.service";
import { WorktreeService } from "../src/services/worktree.service";

function createSessionService() {
  const runner = {
    run: vi.fn(() => new Promise(() => undefined)),
    cancel: vi.fn(),
  } as unknown as AgentRunner;
  const worktrees = {
    prepare: vi.fn(async () => ({
      repoPath: "repo",
      branchName: "agent/test/main",
      worktreePath: "/tmp/worktree",
      summaryPath: "summary.md",
      logPath: "agent.log",
    })),
    complete: vi.fn(),
  } as unknown as WorktreeService;
  const gateway = {
    emitAgentEvent: vi.fn((_event: AgentEvent) => undefined),
  } as never;
  return new SessionService(runner, worktrees, gateway);
}

describe("Hub API - HealthController", () => {
  it("GET /api/health returns ok with service name and timestamp", () => {
    const controller = new HealthController();
    const result = controller.getHealth();

    expect(result.ok).toBe(true);
    expect(result.service).toBe("@agenthub/backend");
    expect(result.ts).toBeTruthy();
    expect(new Date(result.ts).toISOString()).toBe(result.ts);
  });
});

describe("Hub API - SessionController", () => {
  it("GET /api/session/current returns the current session DTO", () => {
    const service = createSessionService();
    const controller = new SessionController(service);
    const session = controller.getCurrent();

    expect(session.id).toBe("session-current");
    expect(session.status).toBe("idle");
    expect(session.runIds).toBeInstanceOf(Array);
    expect(session.createdAt).toBeTruthy();
  });

  it("POST /api/session/run starts a run and returns session + run", async () => {
    const service = createSessionService();
    const controller = new SessionController(service);
    const result = await controller.run({ prompt: "write a test" });

    expect(result.session.status).toBe("running");
    expect(result.session.runIds.length).toBeGreaterThanOrEqual(1);
    expect(result.run.id).toMatch(/^run-/);
    expect(result.run.status).toBe("running");
    expect(result.run.prompt).toBe("write a test");
  });

  it("POST /api/session/run rejects empty prompt with 400", async () => {
    const service = createSessionService();
    const controller = new SessionController(service);

    await expect(controller.run({ prompt: "" })).rejects.toMatchObject({
      response: { code: "PROMPT_REQUIRED" },
      status: 400,
    });
    await expect(controller.run({ prompt: "   " })).rejects.toMatchObject({
      response: { code: "PROMPT_REQUIRED" },
      status: 400,
    });
  });

  it("POST /api/session/run rejects concurrent runs with 409", async () => {
    const service = createSessionService();
    const controller = new SessionController(service);

    await controller.run({ prompt: "first" });
    await expect(controller.run({ prompt: "second" })).rejects.toMatchObject({
      response: { code: "ACTIVE_RUN_EXISTS" },
      status: 409,
    });
  });

  it("POST /api/agent-runs/:runId/cancel cancels a running run", async () => {
    const service = createSessionService();
    const controller = new SessionController(service);

    const started = await controller.run({ prompt: "cancel me" });
    const cancelled = controller.cancel(started.run.id);

    expect(cancelled.run.id).toBe(started.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.session.status).toBe("idle");
  });

  it("POST /api/agent-runs/:runId/cancel returns 404 for unknown runId", () => {
    const service = createSessionService();
    const controller = new SessionController(service);

    expect(() => controller.cancel("run-unknown")).toThrow();
  });

  it("POST /api/session/cancel cancels the current active run", async () => {
    const service = createSessionService();
    const controller = new SessionController(service);

    const started = await controller.run({ prompt: "cancel me" });
    const cancelled = controller.cancelCurrent();

    expect(cancelled.run.id).toBe(started.run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.session.status).toBe("idle");
  });

  it("POST /api/session/cancel returns 409 when no active run exists", () => {
    const service = createSessionService();
    const controller = new SessionController(service);

    expect(() => controller.cancelCurrent()).toThrow();
  });

  it("cancelled run cannot be cancelled again", async () => {
    const service = createSessionService();
    const controller = new SessionController(service);

    const started = await controller.run({ prompt: "cancel me" });
    controller.cancel(started.run.id);

    expect(() => controller.cancel(started.run.id)).toThrow();
  });
});
