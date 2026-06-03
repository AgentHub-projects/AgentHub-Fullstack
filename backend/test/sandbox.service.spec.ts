import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxService } from "../src/modules/hub/services/sandbox.service";

const now = new Date("2026-06-03T10:00:00.000Z");

describe("SandboxService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENTHUB_SANDBOX_BASE_URL;
    delete process.env.AGENTHUB_SANDBOX_TOKEN_SECRET;
    delete process.env.AGENTHUB_SANDBOX_CALLBACK_SECRET;
  });

  it("marks agents unavailable when sandbox is not configured", async () => {
    const service = new SandboxService(prismaMock(), eventsMock(), gatewayMock());

    const result = await service.listAgents("session-1");

    expect(result.sandboxConfigured).toBe(false);
    expect(result.items).toEqual([
      {
        agentId: 7,
        agentName: "Frontend Agent",
        branch: null,
        workspaceId: "project-project-1",
        status: "unavailable",
        message: "沙箱服务未配置",
      },
    ]);
  });

  it("issues a scoped short lived sandbox token", async () => {
    process.env.AGENTHUB_SANDBOX_BASE_URL = "http://sandbox.local/";
    process.env.AGENTHUB_SANDBOX_TOKEN_SECRET = "secret";
    const prisma = prismaMock();
    const service = new SandboxService(prisma, eventsMock(), gatewayMock());

    const result = await service.connect("session-1", 7);

    expect(result.sandboxBaseUrl).toBe("http://sandbox.local");
    expect(result.workspaceId).toBe("project-project-1");
    expect(result.branch).toBe("agent-7");
    expect(result.token.split(".")).toHaveLength(2);
    expect(prisma.session.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session-1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            sandboxWorkspace: expect.objectContaining({
              workspaceId: "project-project-1",
              agentBranches: expect.objectContaining({ 7: "agent-7" }),
            }),
          }),
        }),
      }),
    );
  });

  it("records sandbox saved file as an applied file change", async () => {
    process.env.AGENTHUB_SANDBOX_BASE_URL = "http://sandbox.local";
    process.env.AGENTHUB_SANDBOX_TOKEN_SECRET = "secret";
    const prisma = prismaMock();
    const events = eventsMock();
    const gateway = gatewayMock();
    const service = new SandboxService(prisma, events, gateway);
    const connection = await service.connect("session-1", 7);

    const result = await service.recordFileChangeFromSandbox(
      {
        sessionId: "session-1",
        agentId: 7,
        workspaceId: "project-project-1",
        branch: "agent-7",
        path: "frontend/app/page.tsx",
        beforeContent: "old",
        afterContent: "new",
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      `Bearer ${connection.token}`,
    );

    expect(events.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "file.change",
        source: "sandbox_editor",
        speakerAgentId: 7,
        payload: expect.objectContaining({
          path: "frontend/app/page.tsx",
          metadata: expect.objectContaining({
            source: "sandbox_editor",
            agentId: 7,
            branch: "agent-7",
            sandboxWorkspaceId: "project-project-1",
            applyStatus: "applied",
          }),
        }),
      }),
    );
    expect(result.metadata.applyStatus).toBe("applied");
    expect(gateway.emitSession).toHaveBeenCalled();
  });
});

function prismaMock() {
  return {
    session: {
      findUnique: vi.fn().mockResolvedValue(sessionRow()),
      update: vi.fn().mockResolvedValue({ ...sessionRow(), runs: [] }),
    },
    agentRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "manual-run-1" }),
      update: vi.fn().mockResolvedValue({ id: "manual-run-1" }),
    },
    fileChange: {
      findFirst: vi.fn().mockResolvedValue({
        id: "change-1",
        sessionId: "session-1",
        runId: "manual-run-1",
        artifactId: null,
        producingEventId: "event-file",
        path: "frontend/app/page.tsx",
        oldPath: null,
        changeType: "modified",
        language: null,
        beforeContent: "old",
        beforeSha256: null,
        beforeTruncated: false,
        afterContent: "new",
        afterSha256: null,
        afterTruncated: false,
        patch: "@@ -1 +1 @@\n-old\n+new",
        stats: {},
        metadata: { applyStatus: "applied", source: "sandbox_editor" },
        createdAt: now,
      }),
    },
  } as any;
}

function eventsMock() {
  return {
    append: vi
      .fn()
      .mockResolvedValueOnce({ id: "event-file" })
      .mockResolvedValueOnce({ id: "event-completed" }),
  } as any;
}

function gatewayMock() {
  return { emitSession: vi.fn() } as any;
}

function sessionRow() {
  return {
    id: "session-1",
    title: "Sandbox Demo",
    status: "active",
    projectId: "project-1",
    project: { id: "project-1", name: "Demo", githubUrl: "https://github.com/acme/demo", defaultBranch: "main" },
    metadata: {},
    createdAt: now,
    updatedAt: now,
    participants: [
      {
        sessionId: "session-1",
        agentId: 7,
        participantRole: "member",
        source: "mention",
        createdAt: now,
        agent: { id: 7, name: "Frontend Agent" },
      },
    ],
    runs: [],
  };
}
