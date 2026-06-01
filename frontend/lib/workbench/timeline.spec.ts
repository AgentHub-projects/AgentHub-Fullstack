import { describe, expect, it } from "vitest";
import type { HubArtifactDto, HubMessageDto, HubRunDto, HubSessionDto, SessionDetailDto } from "@agenthub/shared";
import { buildConversationItems } from "./timeline";

const now = "2026-06-02T09:00:00.000Z";

describe("buildConversationItems", () => {
  it("keeps unattached artifacts on the owning run", () => {
    const detail = detailFixture({
      artifacts: [artifactFixture({ id: "artifact-run", runId: "run-1", title: "运行产物" })],
    });

    const runItem = buildConversationItems(detail).find((item) => item.kind === "run");

    expect(runItem?.kind).toBe("run");
    if (runItem?.kind !== "run") return;
    expect(runItem.artifacts).toEqual([expect.objectContaining({ id: "artifact-run", title: "运行产物" })]);
  });

  it("does not duplicate artifacts that are already attached to message parts", () => {
    const detail = detailFixture({
      messages: [
        messageFixture({
          id: "message-1",
          runId: "run-1",
          parts: [
            {
              id: "artifact_artifact-1",
              type: "artifact",
              title: "已挂载产物",
              metadata: { artifactId: "artifact-1" },
            },
          ],
        }),
      ],
      artifacts: [artifactFixture({ id: "artifact-1", runId: "run-1", title: "已挂载产物" })],
    });

    const runItem = buildConversationItems(detail).find((item) => item.kind === "run");

    expect(runItem?.kind).toBe("run");
    if (runItem?.kind !== "run") return;
    expect(runItem.artifacts).toEqual([]);
  });
});

function detailFixture(overrides: Partial<SessionDetailDto> = {}): SessionDetailDto {
  return {
    session: sessionFixture(),
    messages: [],
    runs: [runFixture()],
    events: [],
    artifacts: [],
    fileChanges: [],
    ...overrides,
  };
}

function sessionFixture(): HubSessionDto {
  return {
    id: "session-1",
    title: "测试会话",
    status: "active",
    isPinned: false,
    projectId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function runFixture(): HubRunDto {
  return {
    id: "run-1",
    sessionId: "session-1",
    orchestratorAgentId: 1,
    userMessageId: null,
    assistantMessageId: null,
    contextSnapshotId: null,
    status: "completed",
    downstreamSessionId: null,
    downstreamRunId: null,
    errorCode: null,
    errorMessage: null,
    usageJson: {},
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function messageFixture(overrides: Partial<HubMessageDto> = {}): HubMessageDto {
  const parts = overrides.parts ?? [];
  return {
    id: "message-1",
    sessionId: "session-1",
    runId: "run-1",
    role: "assistant",
    agentId: 1,
    agentName: "agent",
    parentMessageId: null,
    contentText: "done",
    contentJson: { parts },
    parts,
    tokenCount: 1,
    status: "completed",
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function artifactFixture(overrides: Partial<HubArtifactDto> = {}): HubArtifactDto {
  return {
    id: "artifact-1",
    sessionId: "session-1",
    runId: "run-1",
    producingEventId: "event-1",
    artifactKey: "preview",
    kind: "html",
    title: "预览",
    mimeType: "text/html",
    storageKind: "inline_text",
    storageUri: null,
    textContent: "<main />",
    sha256: "sha",
    sizeBytes: 8,
    version: 1,
    final: true,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
