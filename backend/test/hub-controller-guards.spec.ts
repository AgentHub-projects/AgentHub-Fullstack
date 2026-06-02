import { describe, expect, it, vi } from "vitest";
import {
  HubSessionController,
  assertSessionActive,
  assertSessionWritable,
} from "../src/modules/hub/controllers/hub.controller";

describe("Hub controller session write guards", () => {
  it("allows active sessions for read-write endpoints", async () => {
    const prisma = createPrisma({ status: "active", activeRun: null });

    await expect(assertSessionActive(prisma as any, "session-1")).resolves.toBeUndefined();
    expect(prisma.agentRun.findFirst).not.toHaveBeenCalled();
  });

  it("rejects archived sessions for read-write endpoints", async () => {
    const prisma = createPrisma({ status: "archived", activeRun: null });

    await expect(assertSessionActive(prisma as any, "session-1")).rejects.toThrow("SESSION_NOT_ACTIVE");
  });

  it("allows active sessions without active runs", async () => {
    const prisma = createPrisma({ status: "active", activeRun: null });

    await expect(assertSessionWritable(prisma as any, "session-1")).resolves.toBeUndefined();

    expect(prisma.agentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session-1" }),
    }));
  });

  it("rejects archived sessions", async () => {
    const prisma = createPrisma({ status: "archived", activeRun: null });

    await expect(assertSessionWritable(prisma as any, "session-1")).rejects.toThrow("SESSION_NOT_ACTIVE");
    expect(prisma.agentRun.findFirst).not.toHaveBeenCalled();
  });

  it("rejects sessions with an active run", async () => {
    const prisma = createPrisma({ status: "active", activeRun: { id: "run-1" } });

    await expect(assertSessionWritable(prisma as any, "session-1")).rejects.toThrow("SESSION_HAS_ACTIVE_RUN");
  });

  it("guards deployment requests against concurrent active runs", async () => {
    const prisma = createPrisma({ status: "active", activeRun: { id: "run-1" } });
    const deployments = { start: vi.fn() };
    const controller = new HubSessionController({} as any, prisma as any, {} as any, deployments as any);

    await expect(controller.startDeployment("session-1", {})).rejects.toThrow("SESSION_HAS_ACTIVE_RUN");

    expect(deployments.start).not.toHaveBeenCalled();
  });
});

function createPrisma(input: { status: string | null; activeRun: { id: string } | null }) {
  return {
    session: {
      findUnique: vi.fn(async () => (input.status ? { status: input.status } : null)),
    },
    agentRun: {
      findFirst: vi.fn(async () => input.activeRun),
    },
  };
}
