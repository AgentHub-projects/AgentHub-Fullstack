import { describe, expect, it } from "vitest";
import type { SessionDto, AgentEvent } from "@agenthub/shared";
import { initialSession, initialEvents } from "../lib/agenthub-api";

describe("Workbench smoke - initial state", () => {
  it("initial session has offline placeholder values", () => {
    expect(initialSession.id).toBe("local-offline-session");
    expect(initialSession.status).toBe("idle");
    expect(initialSession.title).toContain("等待连接后端会话");
    expect(initialSession.runIds).toBeInstanceOf(Array);
    expect(initialSession.runIds.length).toBe(0);
    expect(initialSession.prompt).toContain("todolist");
  });

  it("initial events array is empty", () => {
    expect(initialEvents).toBeInstanceOf(Array);
    expect(initialEvents.length).toBe(0);
  });
});

describe("Workbench smoke - type contracts", () => {
  it("SessionDto status values are valid", () => {
    const validStatuses: SessionDto["status"][] = [
      "idle",
      "running",
      "succeeded",
      "failed",
    ];

    for (const status of validStatuses) {
      const session: SessionDto = {
        id: "test",
        status,
        runIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(session.status).toBe(status);
    }
  });

  it("AgentEvent types match the shared contract", () => {
    const eventTypes = [
      "agent_started",
      "agent_thinking",
      "text_delta",
      "code_diff",
      "preview_card",
      "agent_completed",
      "agent_failed",
      "agent_cancelled",
      "conflict_card",
      "done",
    ] as const;

    for (const type of eventTypes) {
      const event: AgentEvent = {
        eventId: `evt-${type}`,
        type,
        runId: "run-1",
        conversationId: "conv-1",
        agentId: "agent-1",
        payload: {},
        seq: 1,
        ts: Date.now(),
      };
      expect(event.type).toBe(type);
      expect(event.eventId).toBeTruthy();
    }
  });

  it("Workbench contract fields for inspector panel are populated", () => {
    const session: SessionDto = {
      id: "session-test",
      title: "Test Session",
      status: "running",
      agentId: "claude-code-agent",
      runIds: ["run-001"],
      prompt: "build todolist",
      output: "Mock output",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      testSync: {
        status: "synced",
        targetBranch: "main",
        commitSha: "abc123",
        summaryPath: "summary.md",
      },
    };

    // These match the contractFields array generated in the Workbench page.tsx
    const contractFields: [string, string][] = [
      ["GET /api/session/current", "GET /api/session/current"],
      ["POST /api/session/run", "POST /api/session/run"],
      ["POST /api/agent-runs/:runId/cancel", "POST /api/agent-runs/:runId/cancel"],
      ["Socket AgentEvent", "Socket AgentEvent / agent:event / session:event"],
      ["SessionDto.id", session.id],
      ["SessionDto.status", session.status],
      ["SessionDto.agentId", session.agentId ?? "claude-code-agent"],
      ["SessionDto.output", session.output ?? "无后端输出"],
      ["SessionDto.runIds", session.runIds.join(", ")],
      ["testSync.status", session.testSync?.status ?? "pending"],
      ["testSync.targetBranch", session.testSync?.targetBranch ?? "main"],
      ["testSync.summaryPath", session.testSync?.summaryPath ?? "未返回"],
    ];

    expect(contractFields.length).toBeGreaterThanOrEqual(10);
    for (const [, value] of contractFields) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});
