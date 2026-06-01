import { describe, expect, it, vi } from "vitest";
import { HubEventService } from "../src/modules/hub/services/event.service";

const now = new Date("2026-06-02T09:00:00.000Z");

describe("HubEventService artifact message parts", () => {
  it("buffers message deltas without persisting or broadcasting each chunk", async () => {
    const { service, prisma, gateway } = createService();
    prisma.message.create.mockImplementation(async ({ data }: any) => messageRow({ ...data, id: "message-1" }));

    await service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "message.delta",
      speakerAgentId: 2,
      seq: 1,
      payload: { text: "hello " },
    });
    await service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "message.delta",
      speakerAgentId: 2,
      seq: 2,
      payload: { text: "world" },
    });
    await service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "message.completed",
      speakerAgentId: 2,
      seq: 3,
      payload: {},
    });

    expect(prisma.agentEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.agentEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: "message.completed", seq: 3n }),
    }));
    expect(gateway.emitEvent).toHaveBeenCalledTimes(1);
    expect(prisma.message.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contentText: "hello world" }),
    }));
  });

  it("buffers artifact cards until the speaker assistant message is completed", async () => {
    const { service, prisma, artifacts } = createService();
    artifacts.upsertArtifact.mockResolvedValue(artifactRow({ id: "artifact-1", title: "预览页" }));
    prisma.message.findFirst.mockResolvedValue(null);

    await service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "artifact.upsert",
      speakerAgentId: 2,
      payload: { artifactKey: "preview", title: "预览页", kind: "html" },
    });

    prisma.message.create.mockImplementation(async ({ data }: any) => messageRow({ ...data, id: "message-1" }));
    await service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "message.completed",
      speakerAgentId: 2,
      payload: { text: "页面已经生成" },
    });

    const createData = prisma.message.create.mock.calls[0]?.[0]?.data;
    expect(createData.contentJson.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "页面已经生成" }),
        expect.objectContaining({
          id: "artifact_artifact-1",
          type: "artifact",
          title: "预览页",
          metadata: expect.objectContaining({ artifactId: "artifact-1", kind: "html" }),
        }),
      ]),
    );
    expect(prisma.agentRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-1" },
      data: { assistantMessageId: "message-1" },
    }));
  });

  it("persists rich message parts from downstream completed messages", async () => {
    const { service, prisma } = createService();
    prisma.message.create.mockImplementation(async ({ data }: any) => messageRow({ ...data, id: "message-1" }));

    await service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "message.completed",
      speakerAgentId: 2,
      payload: {
        text: "已生成 Diff",
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
      },
    });

    const createData = prisma.message.create.mock.calls[0]?.[0]?.data;
    expect(createData.contentJson.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "已生成 Diff" }),
        expect.objectContaining({
          id: "diff_1",
          type: "diff",
          title: "src/app.ts",
          metadata: expect.objectContaining({ path: "src/app.ts", patch: "@@ -1 +1 @@\n-old\n+new" }),
        }),
      ]),
    );
  });

  it("adds artifact cards to an existing speaker assistant message", async () => {
    const { service, prisma, artifacts, gateway } = createService();
    const existing = messageRow({
      id: "message-1",
      contentText: "先前回复",
      contentJson: { parts: [{ id: "part_1", type: "text", text: "先前回复" }] },
    });
    artifacts.completeArtifact.mockResolvedValue(artifactRow({
      id: "artifact-2",
      title: "结果图",
      kind: "image",
      mimeType: "image/png",
      textContent: null,
    }));
    prisma.message.findFirst.mockResolvedValue(existing);
    prisma.message.update.mockImplementation(async ({ data }: any) => messageRow({ ...existing, ...data }));

    await service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "artifact.complete",
      speakerAgentId: 2,
      payload: { artifactKey: "result-image" },
    });

    const updateData = prisma.message.update.mock.calls[0]?.[0]?.data;
    expect(updateData.contentJson.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "part_1", type: "text" }),
        expect.objectContaining({
          id: "artifact_artifact-2",
          type: "artifact",
          title: "结果图",
          metadata: expect.objectContaining({ artifactId: "artifact-2", kind: "image" }),
        }),
      ]),
    );
    expect(gateway.emitMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "message-1" }));
  });

  it("leaves artifacts without a speaker at run level", async () => {
    const { service, prisma, artifacts, gateway } = createService();
    artifacts.completeArtifact.mockResolvedValue(artifactRow({
      id: "artifact-run",
      title: "运行日志",
      kind: "log",
      mimeType: "text/plain",
    }));
    prisma.message.findFirst.mockResolvedValue(messageRow({ id: "message-1", contentText: "已有回复" }));

    await service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "artifact.complete",
      payload: { artifactKey: "run-log", title: "运行日志" },
    });

    expect(gateway.emitArtifact).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({ id: "artifact-run", title: "运行日志" }),
    );
    expect(prisma.message.findFirst).not.toHaveBeenCalled();
    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(gateway.emitMessage).not.toHaveBeenCalled();
  });

  it("marks file changes with diff apply conflict status", async () => {
    const { service, prisma, gateway } = createService();
    const existing = fileChangeRow({ id: "change-1", metadata: {} });
    prisma.fileChange.findFirst.mockResolvedValue(existing);
    prisma.fileChange.update.mockImplementation(async ({ data }: any) =>
      fileChangeRow({ ...existing, metadata: data.metadata }),
    );

    await service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "diff.apply.failed",
      payload: {
        fileChangeIds: ["change-1"],
        status: "conflict",
        message: "patch conflict in src/app/page.tsx",
        conflicts: [{ path: "src/app/page.tsx" }],
      },
    });

    expect(prisma.fileChange.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "change-1" },
      data: {
        metadata: expect.objectContaining({
          applyStatus: "conflict",
          applyMessage: "patch conflict in src/app/page.tsx",
          applyConflicts: [{ path: "src/app/page.tsx" }],
          applyRunId: "run-1",
        }),
      },
    }));
    expect(gateway.emitFileChange).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        id: "change-1",
        metadata: expect.objectContaining({ applyStatus: "conflict" }),
      }),
    );
  });

  it("rejects file changes without patch or before/after content", async () => {
    const { service, prisma } = createService();

    await expect(service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "file.change",
      payload: {
        path: "src/app/page.tsx",
        changeType: "modified",
      },
    })).rejects.toThrow("FILE_CHANGE_CONTENT_REQUIRED");

    expect(prisma.agentEvent.create).not.toHaveBeenCalled();
    expect(prisma.fileChange.create).not.toHaveBeenCalled();
  });

  it("accepts file changes with before and after content instead of a patch", async () => {
    const { service, prisma, gateway, context } = createService();
    prisma.fileChange.create.mockImplementation(async ({ data }: any) => fileChangeRow({ ...data, id: "change-before-after" }));

    await service.append({
      sessionId: "session-1",
      runId: "run-1",
      eventType: "file.change",
      payload: {
        path: "src/app/page.tsx",
        changeType: "modified",
        before: { content: "" },
        after: { content: "export default function Page() { return null; }" },
      },
    });

    expect(prisma.fileChange.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        path: "src/app/page.tsx",
        beforeContent: "",
        afterContent: "export default function Page() { return null; }",
        patch: undefined,
      }),
    }));
    expect(gateway.emitFileChange).toHaveBeenCalledWith("session-1", expect.objectContaining({ id: "change-before-after" }));
    expect(context.recordContextItem).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: "file_change",
      sourceId: "change-before-after",
    }));
  });
});

function createService() {
  let seq = 0n;
  const prisma = {
    agentRun: {
      findUnique: vi.fn().mockResolvedValue({ status: "running", assistantMessageId: null }),
      update: vi.fn(),
    },
    agent: {
      findUnique: vi.fn().mockResolvedValue({ id: 2, name: "frontend-agent" }),
    },
    agentEvent: {
      aggregate: vi.fn(async () => ({ _max: { seq } })),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: any) => {
        seq = BigInt(data.seq);
        return {
          id: `event-${seq}`,
          persistedAt: now,
          ...data,
        };
      }),
    },
    message: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    fileChange: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
  };
  const gateway = {
    emitEvent: vi.fn(),
    emitArtifact: vi.fn(),
    emitMessage: vi.fn(),
    emitFileChange: vi.fn(),
  };
  const artifacts = {
    upsertArtifact: vi.fn(),
    storeChunk: vi.fn(),
    completeArtifact: vi.fn(),
  };
  const context = {
    estimateTokens: vi.fn((text: string) => text.length),
    recordContextItem: vi.fn(),
  };
  return {
    prisma,
    gateway,
    artifacts,
    context,
    service: new HubEventService(prisma as any, gateway as any, artifacts as any, context as any),
  };
}

function fileChangeRow(overrides: Record<string, any> = {}) {
  return {
    id: "change-1",
    sessionId: "session-1",
    runId: "run-1",
    artifactId: null,
    producingEventId: "event-1",
    path: "src/app/page.tsx",
    oldPath: null,
    changeType: "modified",
    language: "tsx",
    beforeContent: "",
    beforeSha256: null,
    beforeTruncated: false,
    afterContent: "",
    afterSha256: null,
    afterTruncated: false,
    patch: "@@ -1 +1 @@",
    stats: {},
    metadata: {},
    createdAt: now,
    ...overrides,
  };
}

function artifactRow(overrides: Record<string, any> = {}) {
  return {
    id: "artifact-1",
    sessionId: "session-1",
    runId: "run-1",
    producingEventId: "event-1",
    artifactKey: "preview",
    kind: "html",
    title: "预览页",
    mimeType: "text/html; charset=utf-8",
    storageKind: "inline_text",
    storageUri: null,
    textContent: "<main>preview</main>",
    sha256: "sha",
    sizeBytes: 20,
    version: 1,
    final: false,
    metadata: {},
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
    role: "assistant",
    agentId: 2,
    parentMessageId: null,
    contentText: "",
    contentJson: {},
    tokenCount: 0,
    status: "completed",
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
