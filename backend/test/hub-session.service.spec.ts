import { describe, expect, it, vi } from "vitest";
import {
  HubSessionService,
  deriveTitle,
  parseDeploymentCommand,
  referencedPartText,
} from "../src/modules/hub/services/hub-session.service";

const now = new Date("2026-06-02T09:00:00.000Z");

describe("HubSessionService deployment command parsing", () => {
  it("detects generic Vercel deployment commands only", () => {
    expect(parseDeploymentCommand("部署")).toBe(true);
    expect(parseDeploymentCommand("发布到 Vercel")).toBe(true);
    expect(parseDeploymentCommand("请部署到容器")).toBe(false);
    expect(parseDeploymentCommand("源码打包")).toBe(false);
    expect(parseDeploymentCommand("deploy container")).toBe(false);
    expect(parseDeploymentCommand("帮我解释一下部署流程，这不是触发部署")).toBe(false);
  });
});

describe("HubSessionService title derivation", () => {
  it("uses the first direct-chat user message for the default title", () => {
    expect(deriveTitle("新单聊", "用 Claude Code 写一个 React 组件", { mode: "direct", titleSource: "auto" }))
      .toBe("用 Claude Code 写一个 React 组件");
  });

  it("does not overwrite manual or already-derived titles", () => {
    expect(deriveTitle("手动标题", "新的用户消息", { titleSource: "manual" })).toBe("手动标题");
    expect(deriveTitle("首条消息标题", "第二条消息", { titleSource: "auto" })).toBe("首条消息标题");
  });
});

describe("HubSessionService part references", () => {
  it("builds reference text for non-text message parts", () => {
    const text = referencedPartText({
      parts: [
        {
          id: "file_1",
          type: "file",
          title: "需求文档.pdf",
          url: "https://oss.example/requirements.pdf",
          metadata: { mimeType: "application/pdf", sizeBytes: 1024 },
        },
      ],
    }, "file_1");

    expect(text).toContain("type: file");
    expect(text).toContain("title: 需求文档.pdf");
    expect(text).toContain("url: https://oss.example/requirements.pdf");
    expect(text).toContain("mimeType: application/pdf");
  });

  it("keeps code/text part content in references", () => {
    expect(referencedPartText({
      parts: [{ id: "code_1", type: "code", language: "ts", text: "const ok = true;" }],
    }, "code_1")).toContain("const ok = true;");
  });

  it("keeps diff metadata patch in part references", () => {
    const text = referencedPartText({
      parts: [
        {
          id: "diff_1",
          type: "diff",
          title: "src/app.ts",
          metadata: {
            path: "src/app.ts",
            changeType: "modified",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        },
      ],
    }, "diff_1");

    expect(text).toContain("path: src/app.ts");
    expect(text).toContain("changeType: modified");
    expect(text).toContain("patch:\n@@ -1 +1 @@\n-old\n+new");
  });
});

describe("HubSessionService participant guards", () => {
  it("rejects adding participants while a run is active", async () => {
    const prisma = {
      session: {
        findUnique: vi.fn().mockResolvedValue({ status: "active", metadata: {} }),
      },
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({ id: "run-1" }),
      },
      sessionAgent: {
        upsert: vi.fn(),
      },
    };
    const agents = {
      getAgent: vi.fn(),
    };
    const service = new HubSessionService(
      prisma as any,
      agents as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.addParticipant("session-1", { agentId: 2 })).rejects.toThrow("SESSION_HAS_ACTIVE_RUN");
    expect(agents.getAgent).not.toHaveBeenCalled();
    expect(prisma.sessionAgent.upsert).not.toHaveBeenCalled();
  });

  it("adds participants without creating a synthetic run when there is no history", async () => {
    const session = sessionRow({ metadata: { memberAgentIds: [2] } });
    const prisma = {
      session: {
        findUnique: vi.fn().mockResolvedValue({ status: "active", metadata: { memberAgentIds: [] } }),
        update: vi.fn().mockResolvedValue(session),
      },
      agentRun: {
        findFirst: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
      },
      sessionAgent: {
        upsert: vi.fn(),
      },
    };
    const agents = {
      getAgent: vi.fn().mockResolvedValue(agentRow({ id: 2, name: "frontend-agent" })),
    };
    const downstream = {
      notifyMemberAdded: vi.fn(),
    };
    const events = {
      append: vi.fn(),
    };
    const gateway = {
      emitSession: vi.fn(),
    };
    const service = new HubSessionService(
      prisma as any,
      agents as any,
      {} as any,
      downstream as any,
      events as any,
      {} as any,
      gateway as any,
    );

    await service.addParticipant("session-1", { agentId: 2 });

    expect(events.append).not.toHaveBeenCalled();
    expect(downstream.notifyMemberAdded).toHaveBeenCalledWith("session-1", {
      agentId: 2,
      description: "前端实现",
    });
    expect(gateway.emitSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }));
  });
});

describe("HubSessionService pin events", () => {
  it("pins messages without creating a synthetic run when the message has no run", async () => {
    const prisma = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    const context = {
      setMessagePinned: vi.fn().mockResolvedValue(messageRow({ runId: null, isPinned: true })),
    };
    const downstream = {
      notifyPinUpdated: vi.fn(),
    };
    const events = {
      append: vi.fn(),
    };
    const service = new HubSessionService(
      prisma as any,
      {} as any,
      context as any,
      downstream as any,
      events as any,
      {} as any,
      {} as any,
    );

    const result = await service.pinMessage("session-1", "message-1", { pinned: true });

    expect(result.isPinned).toBe(true);
    expect(events.append).not.toHaveBeenCalled();
    expect(downstream.notifyPinUpdated).toHaveBeenCalledWith("session-1", {
      messageId: "message-1",
      partId: undefined,
      pinned: true,
    });
  });
});

describe("HubSessionService diff apply guards", () => {
  it("rejects applying file changes while a run is active", async () => {
    const prisma = {
      session: {
        findUnique: vi.fn().mockResolvedValue({ status: "active" }),
      },
      agentRun: {
        findFirst: vi.fn().mockResolvedValue({ id: "active-run" }),
      },
      fileChange: {
        findFirst: vi.fn(),
      },
    };
    const downstream = {
      applyFileChanges: vi.fn(),
    };
    const service = new HubSessionService(
      prisma as any,
      {} as any,
      {} as any,
      downstream as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.applyFileChange("session-1", "change-1")).rejects.toThrow("SESSION_HAS_ACTIVE_RUN");

    expect(prisma.fileChange.findFirst).not.toHaveBeenCalled();
    expect(downstream.applyFileChanges).not.toHaveBeenCalled();
  });
});

describe("HubSessionService deployment command lifecycle", () => {
  it("completes the command run after deployment starts successfully", async () => {
    const run = runRow({ status: "queued" });
    const completedRun = runRow({ status: "completed", completedAt: now });
    const deploymentMessage = messageRow({ id: "deployment-message", role: "system", contentText: "Vercel 部署排队" });
    const prisma = createDeploymentCommandPrisma(run, completedRun);
    const deployments = {
      start: vi.fn().mockResolvedValue({
        deployment: { id: "deployment-1", commitSha: "abcdef123456" },
        message: deploymentMessage,
      }),
    };
    const service = createDeploymentCommandService(prisma, deployments);

    const result = await service.sendMessage("session-1", { content: "部署" });

    expect(prisma.agentRun.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "queued" }),
    }));
    expect(prisma.agentRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1" },
      data: expect.objectContaining({ status: "completed" }),
    }));
    expect(result.run.status).toBe("completed");
    expect(result.messages?.map((message) => message.id)).toEqual(["message-1", "deployment-message"]);
    expect(deployments.start).toHaveBeenCalledWith("session-1", {});
  });

  it("marks the command run failed when deployment cannot start", async () => {
    const run = runRow({ status: "queued" });
    const failedRun = runRow({
      status: "failed",
      errorCode: "DEPLOYMENT_TRIGGER_FAILED",
      errorMessage: "NO_SUCCESSFUL_PUSH_COMMIT",
      completedAt: now,
    });
    const prisma = createDeploymentCommandPrisma(run, failedRun);
    const events = { append: vi.fn() };
    const service = createDeploymentCommandService(
      prisma,
      { start: vi.fn().mockRejectedValue(new Error("NO_SUCCESSFUL_PUSH_COMMIT")) },
      events,
    );

    await expect(service.sendMessage("session-1", { content: "部署" })).rejects.toThrow("NO_SUCCESSFUL_PUSH_COMMIT");

    expect(prisma.agentRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1" },
      data: expect.objectContaining({
        status: "failed",
        errorCode: "DEPLOYMENT_TRIGGER_FAILED",
        errorMessage: "NO_SUCCESSFUL_PUSH_COMMIT",
      }),
    }));
    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "run.failed",
      payload: expect.objectContaining({ message: "NO_SUCCESSFUL_PUSH_COMMIT" }),
    }));
  });
});

function sessionRow(overrides: Record<string, any> = {}) {
  return {
    id: "session-1",
    title: "会话",
    status: "active",
    projectId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    runs: [],
    ...overrides,
  };
}

function agentRow(overrides: Record<string, any> = {}) {
  const now = new Date("2026-06-02T09:00:00.000Z");
  return {
    id: 2,
    templateId: 10,
    name: "frontend-agent",
    description: "前端实现",
    provider: "claude-code",
    isDefaultOrchestrator: false,
    status: "enabled",
    capabilities: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function messageRow(overrides: Record<string, any> = {}) {
  return {
    id: "message-1",
    sessionId: "session-1",
    runId: "run-1",
    role: "user",
    agentId: null,
    parentMessageId: null,
    contentText: "hello",
    contentJson: {},
    tokenCount: 0,
    status: "completed",
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function runRow(overrides: Record<string, any> = {}) {
  return {
    id: "run-1",
    sessionId: "session-1",
    orchestratorAgentId: 2,
    userMessageId: "message-1",
    assistantMessageId: null,
    contextSnapshotId: null,
    status: "queued",
    downstreamSessionId: null,
    downstreamRunId: null,
    errorCode: null,
    errorMessage: null,
    usageJson: {},
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createDeploymentCommandPrisma(run: Record<string, any>, updatedRun: Record<string, any>) {
  return {
    session: {
      findUnique: vi.fn().mockResolvedValue(sessionRow({
        metadata: { mode: "direct", directAgentId: 2 },
        projectId: "project-1",
      })),
      update: vi.fn().mockResolvedValue(sessionRow({
        metadata: { mode: "direct", directAgentId: 2 },
        projectId: "project-1",
        runs: [updatedRun],
      })),
    },
    agentRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(run),
      update: vi.fn().mockResolvedValue(updatedRun),
    },
    message: {
      create: vi.fn().mockResolvedValue(messageRow({ contentText: "部署" })),
    },
  };
}

function createDeploymentCommandService(
  prisma: Record<string, any>,
  deployments: { start: ReturnType<typeof vi.fn> },
  events = { append: vi.fn() },
) {
  return new HubSessionService(
    prisma as any,
    { getAgent: vi.fn().mockResolvedValue(agentRow({ id: 2 })) } as any,
    { estimateTokens: vi.fn((text: string) => text.length), recordContextItem: vi.fn() } as any,
    {} as any,
    events as any,
    deployments as any,
    { emitSession: vi.fn() } as any,
  );
}
