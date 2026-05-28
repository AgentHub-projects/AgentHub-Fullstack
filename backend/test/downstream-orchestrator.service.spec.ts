import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInstanceDto, HubContextSnapshotDto } from "@agenthub/shared";

type Handler = (...args: any[]) => void;

const socketMock = vi.hoisted(() => {
  class FakeSocket {
    connected = true;
    emitted: Array<{ event: string; payload: any }> = [];
    handlers = new Map<string, Handler[]>();
    emit = vi.fn((event: string, payload: any) => {
      this.emitted.push({ event, payload });
      return this;
    });

    on(event: string, handler: Handler) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      if (event === "connect") handler();
      return this;
    }

    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }

    off(event: string, handler: Handler) {
      const handlers = this.handlers.get(event) ?? [];
      this.handlers.set(event, handlers.filter((current) => current !== handler));
      return this;
    }

    disconnect = vi.fn(() => {
      if (!this.connected) return this;
      this.connected = false;
      this.trigger("disconnect", "io client disconnect");
      return this;
    });

    trigger(event: string, ...args: any[]) {
      if (event === "disconnect") this.connected = false;
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return {
    sockets: [] as InstanceType<typeof FakeSocket>[],
    io: vi.fn(() => {
      const socket = new FakeSocket();
      socketMock.sockets.push(socket);
      return socket;
    }),
  };
});

vi.mock("socket.io-client", () => ({
  io: socketMock.io,
}));

import { DownstreamOrchestratorService } from "../src/hub/downstream-orchestrator.service";

const now = new Date("2026-05-28T08:00:00.000Z");
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const IDLE_RECHECK_MS = 60 * 1000;

describe("DownstreamOrchestratorService prompt transfer", () => {
  const originalUrl = process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL;

  beforeEach(() => {
    socketMock.sockets.length = 0;
    socketMock.io.mockClear();
    process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL = "http://downstream.test/acp";
  });

  afterEach(() => {
    process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL = originalUrl;
    vi.useRealTimers();
  });

  it("sends bootstrap payload on the first downstream prompt", async () => {
    const service = createService();

    await service.startRun(createRunInput("run-1", "请实现登录页"));

    expect(socketMock.io).toHaveBeenCalledWith("http://downstream.test/acp", {
      transports: ["websocket"],
      reconnection: false,
    });
    const params = lastPromptParams();
    expect(params.mode).toBe("bootstrap");
    expect(params.prompt).toBe("请实现登录页");
    expect(params.pins).toEqual(context.snapshotJson.pins);
    expect(params.orchestratorSystemPrompt).toBe("orchestrator system prompt");
    expect(params.agents).toEqual([
      { agentId: "frontend-agent-id", description: "前端成员描述" },
      { agentId: "backend-agent-id", description: "后端模板描述" },
    ]);
    expect(params.memory).toEqual({
      summary: "摘要记忆",
      retrieved: context.snapshotJson.retrieved,
    });
    expect(JSON.stringify(params)).not.toContain("recent should not be sent");
    expect(JSON.stringify(params)).not.toContain("rendered context prompt should not be sent");
  });

  it("sends only prompt and pins while the downstream connection is alive", async () => {
    const service = createService();

    await service.startRun(createRunInput("run-1", "第一次需求"));
    await service.startRun(createRunInput("run-2", "第二次需求"));

    const params = lastPromptParams();
    expect(socketMock.io).toHaveBeenCalledTimes(1);
    expect(params.mode).toBe("incremental");
    expect(params.prompt).toBe("第二次需求");
    expect(params.pins).toEqual(context.snapshotJson.pins);
    expect(params.memory).toBeUndefined();
    expect(params.orchestratorSystemPrompt).toBeUndefined();
    expect(params.agents).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain("recent should not be sent");
  });

  it("returns to bootstrap mode after the downstream socket disconnects", async () => {
    const service = createService();

    await service.startRun(createRunInput("run-1", "第一次需求"));
    socketMock.sockets[0].trigger("disconnect", "transport close");
    await service.startRun(createRunInput("run-2", "断线后的需求"));

    const params = lastPromptParams();
    expect(socketMock.io).toHaveBeenCalledTimes(2);
    expect(params.mode).toBe("bootstrap");
    expect(params.memory).toEqual({
      summary: "摘要记忆",
      retrieved: context.snapshotJson.retrieved,
    });
  });

  it("keeps idle downstream connections while frontend subscribers exist", async () => {
    vi.useFakeTimers();
    const gateway = createGateway();
    const service = createService({ gateway });

    gateway.hasSessionSubscribers.mockReturnValue(true);
    await service.startRun(createRunInput("run-1", "保持连接"));

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(socketMock.sockets[0].disconnect).not.toHaveBeenCalled();

    gateway.hasSessionSubscribers.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(IDLE_RECHECK_MS);
    expect(socketMock.sockets[0].disconnect).toHaveBeenCalledTimes(1);
  });
});

const orchestrator: AgentInstanceDto = {
  id: "orchestrator-id",
  templateId: "orchestrator-template-id",
  name: "main-orchestrator",
  description: "主协调者",
  provider: 0,
  isDefaultOrchestrator: true,
  status: "enabled",
  template: {
    id: "orchestrator-template-id",
    name: "Orchestrator",
    description: "模板描述",
    defaultProvider: 0,
    systemPrompt: "orchestrator system prompt",
    promptConfig: {},
    defaultCapabilities: [],
    defaultModelConfig: {},
    metadata: {},
    status: "enabled",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  },
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

const context: HubContextSnapshotDto = {
  id: "context-id",
  sessionId: "session-1",
  runId: "run-1",
  version: 1,
  tokenBudget: 9000,
  tokenCount: 100,
  selectedItemIds: [],
  promptText: "rendered context prompt should not be sent",
  createdAt: now.toISOString(),
  snapshotJson: {
    pins: [
      {
        id: "pin-1",
        kind: "message",
        text: "本轮 pin",
        tokenCount: 3,
        importance: 100,
        pinned: true,
        createdAt: now.toISOString(),
      },
    ],
    recent: [
      {
        id: "recent-1",
        kind: "message",
        text: "recent should not be sent",
        tokenCount: 5,
        importance: 0,
        pinned: false,
        createdAt: now.toISOString(),
      },
    ],
    retrieved: [
      {
        id: "retrieved-1",
        kind: "artifact",
        text: "召回记忆",
        tokenCount: 8,
        importance: 20,
        pinned: false,
        createdAt: now.toISOString(),
      },
    ],
    summary: "摘要记忆",
    mentionedAgents: [],
  },
};

function createRunInput(runId: string, promptText: string) {
  return {
    sessionId: "session-1",
    runId,
    userMessageId: `message-${runId}`,
    promptText,
    orchestrator,
    mentionedAgents: [],
    context: { ...context, runId },
  };
}

function createService(options?: { gateway?: ReturnType<typeof createGateway> }) {
  return new DownstreamOrchestratorService(
    createPrisma() as any,
    { append: vi.fn().mockResolvedValue({}) } as any,
    (options?.gateway ?? createGateway()) as any,
  );
}

function createPrisma() {
  return {
    agentRun: {
      update: vi.fn().mockResolvedValue({}),
    },
    session: {
      update: vi.fn().mockResolvedValue({
        id: "session-1",
        title: "测试会话",
        status: "active",
        metadata: {},
        createdAt: now,
        updatedAt: now,
        runs: [],
      }),
    },
    sessionAgent: {
      findMany: vi.fn().mockResolvedValue([
        {
          agent: {
            id: "frontend-agent-id",
            description: "前端成员描述",
            template: { description: "前端模板描述" },
          },
        },
        {
          agent: {
            id: "backend-agent-id",
            description: "",
            template: { description: "后端模板描述" },
          },
        },
      ]),
    },
  };
}

function createGateway() {
  return {
    emitSession: vi.fn(),
    hasSessionSubscribers: vi.fn().mockReturnValue(false),
  };
}

function lastPromptParams() {
  const prompts = socketMock.sockets
    .flatMap((socket) => socket.emitted)
    .filter((item) => item.event === "acp:message" && item.payload.method === "session/prompt");
  expect(prompts.length).toBeGreaterThan(0);
  return prompts.at(-1)!.payload.params;
}
