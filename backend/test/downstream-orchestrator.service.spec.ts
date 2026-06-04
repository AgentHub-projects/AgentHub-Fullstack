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

import { DownstreamOrchestratorService } from "../src/modules/hub/services/downstream-orchestrator.service";

const now = new Date("2026-05-28T08:00:00.000Z");
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const IDLE_RECHECK_MS = 60 * 1000;
type StartRunInput = Parameters<DownstreamOrchestratorService["startRun"]>[0];

describe("DownstreamOrchestratorService prompt transfer", () => {
  const originalUrl = process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL;
  const originalSessionLoad = process.env.DOWNSTREAM_ENABLE_SESSION_LOAD;
  const originalContextDelta = process.env.DOWNSTREAM_ENABLE_CONTEXT_DELTA;
  const originalApplyDiff = process.env.DOWNSTREAM_ENABLE_FILE_APPLY_DIFF;

  beforeEach(() => {
    socketMock.sockets.length = 0;
    socketMock.io.mockClear();
    process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL = "http://downstream.test/acp";
    delete process.env.DOWNSTREAM_ENABLE_SESSION_LOAD;
    delete process.env.DOWNSTREAM_ENABLE_CONTEXT_DELTA;
    delete process.env.DOWNSTREAM_ENABLE_FILE_APPLY_DIFF;
  });

  afterEach(() => {
    process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL = originalUrl;
    restoreEnv("DOWNSTREAM_ENABLE_SESSION_LOAD", originalSessionLoad);
    restoreEnv("DOWNSTREAM_ENABLE_CONTEXT_DELTA", originalContextDelta);
    restoreEnv("DOWNSTREAM_ENABLE_FILE_APPLY_DIFF", originalApplyDiff);
    vi.useRealTimers();
  });

  it("sends Gateway-friendly bootstrap payload on the first downstream prompt", async () => {
    const service = createService();

    await startRunWithDownstreamSession(service, createRunInput("run-1", "请实现登录页"), "downstream-session-1");

    expect(socketMock.io).toHaveBeenCalledWith("http://downstream.test/acp", {
      transports: ["websocket"],
      reconnection: false,
    });
    const params = lastPromptParams();
    expect(Object.keys(params).sort()).toEqual(["_meta", "prompt", "sessionId"]);
    expect(params.sessionId).toBe("downstream-session-1");
    expect(params.prompt[0].type).toBe("text");
    expect(params.prompt[0].text).toContain("请实现登录页");
    expect(params.prompt[0].text).toContain("rendered context prompt should not be sent");
    expect(params.prompt[0].text).toContain("前端成员描述");
    expect(params._meta).toEqual(expect.objectContaining({
      source: "agenthub",
      agenthubSessionId: "session-1",
      runId: "run-1",
      messageId: "message-run-1",
      orchestratorAgentId: "1",
      mentionedAgentIds: [],
      contextSnapshotId: "context-id",
      promptMode: "bootstrap",
      orchestratorSystemPrompt: "orchestrator system prompt",
    }));
    expect(params._meta.agents).toEqual([
      { agentId: 2, description: "前端成员描述" },
      { agentId: 3, description: "后端模板描述" },
    ]);
    expect(params._meta.memory.summary).toBe("摘要记忆");
    expect(params._meta.memory.retrieved).toEqual([
      expect.objectContaining({ id: "retrieved-1", text: "召回记忆" }),
    ]);
    expect(params._meta.memory.recent).toEqual([
      expect.objectContaining({ id: "recent-1", text: "最近历史" }),
    ]);
    expect(params._meta.pins).toEqual([
      expect.objectContaining({ id: "pin-1", kind: "message", text: "本轮 pin" }),
    ]);
    expect(firstRequestParams("session/new")._meta).toEqual({ agentId: "1", agenthubSessionId: "session-1" });
  });

  it("uses the current run agent id when creating a downstream session", async () => {
    const service = createService();
    const directAgent = { ...orchestrator, id: 9, name: "direct-agent", isDefaultOrchestrator: false };

    await startRunWithDownstreamSession(
      service,
      { ...createRunInput("run-1", "单聊任务"), orchestrator: directAgent },
      "downstream-session-1",
    );

    expect(firstRequestParams("session/new")._meta).toEqual({ agentId: "9", agenthubSessionId: "session-1" });
  });

  it("saves downstream sandbox mapping from session/new result", async () => {
    const { service, sandboxRegistry } = createServiceHarness();

    await startRunWithDownstreamSession(service, createRunInput("run-1", "建立沙箱映射"), "downstream-session-1", {
      sandbox: {
        baseUrl: "http://sandbox.local",
        workspaceId: "workspace-1",
        agentBranches: { 2: "agent-2" },
      },
    });

    expect(sandboxRegistry.saveFromSessionResult).toHaveBeenCalledWith("session-1", "downstream-session-1", {
      sessionId: "downstream-session-1",
      sandbox: {
        baseUrl: "http://sandbox.local",
        workspaceId: "workspace-1",
        agentBranches: { 2: "agent-2" },
      },
    });
  });

  it("passes mentioned agent ids to the downstream prompt", async () => {
    const service = createService();
    const frontendAgent = {
      ...orchestrator,
      id: 2,
      name: "frontend-agent",
      description: "前端成员",
      isDefaultOrchestrator: false,
    };

    await startRunWithDownstreamSession(
      service,
      {
        ...createRunInput("run-1", "@frontend-agent 实现页面"),
        mentionedAgents: [frontendAgent],
      },
      "downstream-session-1",
    );

    expect(lastPromptParams()._meta.mentionedAgentIds).toEqual(["2"]);
    expect(lastPromptParams().prompt[0].text).toContain("frontend-agent (2)");
  });

  it("sends only the current prompt while the downstream connection is alive", async () => {
    const service = createService();

    await startRunWithDownstreamSession(service, createRunInput("run-1", "第一次需求"), "downstream-session-1");
    await service.startRun(createRunInput("run-2", "第二次需求"));

    const params = lastPromptParams();
    expect(socketMock.io).toHaveBeenCalledTimes(1);
    expect(params.sessionId).toBe("downstream-session-1");
    expect(params._meta.promptMode).toBe("incremental");
    expect(params.prompt[0].text).toContain("第二次需求");
    expect(params._meta.pins).toBeUndefined();
    expect(params._meta.memory).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain("最近历史");
    expect(JSON.stringify(params)).not.toContain("摘要记忆");
  });

  it("returns to bootstrap mode after the downstream socket disconnects", async () => {
    const service = createService();

    await startRunWithDownstreamSession(service, createRunInput("run-1", "第一次需求"), "downstream-session-1");
    socketMock.sockets[0].trigger("disconnect", "transport close");
    await startRunWithDownstreamSession(service, createRunInput("run-2", "断线后的需求"), "downstream-session-2");

    const params = lastPromptParams();
    expect(socketMock.io).toHaveBeenCalledTimes(2);
    expect(params.sessionId).toBe("downstream-session-2");
    expect(params._meta.promptMode).toBe("bootstrap");
    expect(params.prompt[0].text).toContain("断线后的需求");
    expect(params.prompt[0].text).toContain("rendered context prompt should not be sent");
    expect(params._meta.memory.summary).toBe("摘要记忆");
    expect(params._meta.memory.recent).toEqual([
      expect.objectContaining({ id: "recent-1", text: "最近历史" }),
    ]);
    expect(requestFor(socketMock.sockets[1], "session/load")).toBeUndefined();
  });

  it("keeps idle downstream connections while frontend subscribers exist", async () => {
    vi.useFakeTimers();
    const gateway = createGateway();
    const service = createService({ gateway });

    gateway.hasSessionSubscribers.mockReturnValue(true);
    await startRunWithDownstreamSession(service, createRunInput("run-1", "保持连接"), "downstream-session-1");
    socketMock.sockets[0].trigger("acp:message", {
      jsonrpc: "2.0",
      id: 99,
      method: "session/event",
      params: {
        type: "run.completed",
        _meta: { runId: "run-1" },
        payload: { status: "completed" },
      },
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(socketMock.sockets[0].disconnect).not.toHaveBeenCalled();

    gateway.hasSessionSubscribers.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(IDLE_RECHECK_MS);
    expect(socketMock.sockets[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("handles session/update chunks with _meta run and speaker ids", async () => {
    const events = { append: vi.fn().mockResolvedValue({}) };
    const service = createService({ events });
    const socket = await startRunWithDownstreamSession(service, createRunInput("run-1", "流式回复"), "downstream-session-1");
    events.append.mockClear();

    socket.trigger("acp:message", {
      jsonrpc: "2.0",
      id: 55,
      method: "session/update",
      params: {
        update: {
          text: "完成一部分",
          sessionUpdate: "agent_message_stop",
          _meta: { runId: "run-1", agentId: "2" },
        },
      },
    });
    await flushMicrotasks();

    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      eventType: "message.delta",
      speakerAgentId: 2,
      payload: { text: "完成一部分", speaker: "2" },
    }));
    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      eventType: "message.completed",
      speakerAgentId: 2,
      payload: { text: "完成一部分", speaker: "2" },
    }));
    expect(responseFor(socket, 55)).toEqual({ jsonrpc: "2.0", id: 55, result: { ok: true } });
  });

  it("rejects session/update chunks without _meta.runId", async () => {
    const events = { append: vi.fn().mockResolvedValue({}) };
    const service = createService({ events });
    const socket = await startRunWithDownstreamSession(service, createRunInput("run-1", "缺少 run"), "downstream-session-1");
    events.append.mockClear();

    socket.trigger("acp:message", {
      jsonrpc: "2.0",
      id: 56,
      method: "session/update",
      params: {
        update: {
          text: "不会落库",
          _meta: { agentId: "2" },
        },
      },
    });
    await flushMicrotasks();

    expect(events.append).not.toHaveBeenCalled();
    expect(responseFor(socket, 56)).toEqual({
      jsonrpc: "2.0",
      id: 56,
      error: {
        code: "RUN_ID_REQUIRED",
        message: "RUN_ID_REQUIRED",
      },
    });
  });

  it("acks inbound session events only after persistence succeeds", async () => {
    const events = { append: vi.fn().mockResolvedValue({}) };
    const service = createService({ events });
    const socket = await startRunWithDownstreamSession(service, createRunInput("run-1", "事件 ack"), "downstream-session-1");
    events.append.mockClear();

    socket.trigger("acp:message", {
      jsonrpc: "2.0",
      id: 77,
      method: "session/event",
      params: {
        type: "message.completed",
        _meta: { runId: "run-1", agentId: "2" },
        payload: { text: "完成" },
      },
    });
    await flushMicrotasks();

    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      eventType: "message.completed",
      speakerAgentId: 2,
      payload: { text: "完成" },
    }));
    expect(responseFor(socket, 77)).toEqual({ jsonrpc: "2.0", id: 77, result: { ok: true } });
  });

  it("rejects successful ack when inbound event persistence fails", async () => {
    const events = { append: vi.fn().mockResolvedValue({}) };
    const service = createService({ events });
    const socket = await startRunWithDownstreamSession(service, createRunInput("run-1", "事件失败"), "downstream-session-1");
    events.append.mockRejectedValueOnce(new Error("RUN_ALREADY_CANCELLED"));

    socket.trigger("acp:message", {
      jsonrpc: "2.0",
      id: "event-1",
      method: "session/event",
      params: {
        type: "message.completed",
        _meta: { runId: "run-1" },
        payload: { text: "完成" },
      },
    });
    await flushMicrotasks();

    expect(responseFor(socket, "event-1")).toEqual({
      jsonrpc: "2.0",
      id: "event-1",
      error: {
        code: "RUN_ALREADY_CANCELLED",
        message: "RUN_ALREADY_CANCELLED",
      },
    });
  });

  it("rejects session events without _meta.runId", async () => {
    const events = { append: vi.fn().mockResolvedValue({}) };
    const service = createService({ events });
    const socket = await startRunWithDownstreamSession(service, createRunInput("run-1", "事件缺少 run"), "downstream-session-1");
    events.append.mockClear();

    socket.trigger("acp:message", {
      jsonrpc: "2.0",
      id: 66,
      method: "session/event",
      params: {
        runId: "run-1",
        type: "message.completed",
        payload: { text: "不会落库" },
      },
    });
    await flushMicrotasks();

    expect(events.append).not.toHaveBeenCalled();
    expect(responseFor(socket, 66)).toEqual({
      jsonrpc: "2.0",
      id: 66,
      error: {
        code: "RUN_ID_REQUIRED",
        message: "RUN_ID_REQUIRED",
      },
    });
  });

  it("does not append downstream terminal run events twice", async () => {
    const { service, prisma, events } = createServiceHarness();
    const socket = await startRunWithDownstreamSession(service, createRunInput("run-1", "终态事件"), "downstream-session-1");
    events.append.mockClear();

    socket.trigger("acp:message", {
      jsonrpc: "2.0",
      id: 88,
      method: "session/event",
      params: {
        type: "run.completed",
        _meta: { runId: "run-1" },
        payload: { status: "completed" },
      },
    });
    await flushMicrotasks();

    expect(events.append).toHaveBeenCalledTimes(1);
    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ eventType: "run.completed" }));
    expect(prisma.agentRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "run-1" },
      data: expect.objectContaining({ status: "completed", completedAt: expect.any(Date) }),
    }));
    expect(responseFor(socket, 88)).toEqual({ jsonrpc: "2.0", id: 88, result: { ok: true } });
  });

  it("rejects diff apply by default while AgentGateway does not support it", async () => {
    const { service } = createServiceHarness();

    await expect(service.applyFileChanges({
      sessionId: "session-1",
      runId: "run-1",
      fileChangeIds: ["change-1"],
      changes: [{ id: "change-1", path: "src/app.ts", patch: "@@ -1 +1 @@" }],
    })).rejects.toThrow("DOWNSTREAM_APPLY_NOT_SUPPORTED");
    expect(socketMock.sockets.length).toBe(0);
  });

  it("loads the downstream session before applying a diff when optional support is enabled", async () => {
    process.env.DOWNSTREAM_ENABLE_FILE_APPLY_DIFF = "true";
    process.env.DOWNSTREAM_ENABLE_SESSION_LOAD = "true";
    const { service, prisma } = createServiceHarness();
    prisma.agentRun.findUnique.mockResolvedValue({
      orchestratorAgentId: 1,
      downstreamSessionId: "downstream-session-1",
    });

    const pending = service.applyFileChanges({
      sessionId: "session-1",
      runId: "run-1",
      fileChangeIds: ["change-1"],
      changes: [{ id: "change-1", path: "src/app.ts", patch: "@@ -1 +1 @@" }],
    });
    await flushMicrotasks();

    const socket = socketMock.sockets.at(-1);
    expect(socket).toBeDefined();
    const load = requestFor(socket!, "session/load");
    expect(load?.params).toEqual({ sessionId: "downstream-session-1" });

    socket!.trigger("acp:message", { jsonrpc: "2.0", id: load!.id, result: { sessionId: "downstream-session-1" } });
    await pending;

    const apply = requestFor(socket!, "file/apply_diff");
    expect(apply?.params).toEqual({
      sessionId: "downstream-session-1",
      fileChangeIds: ["change-1"],
      changes: [{ id: "change-1", path: "src/app.ts", patch: "@@ -1 +1 @@" }],
      _meta: {
        source: "agenthub",
        agenthubSessionId: "session-1",
        runId: "run-1",
      },
    });
    expect(requestFor(socket!, "session/new")).toBeUndefined();
  });

  it("saves downstream sandbox mapping from session/load result", async () => {
    process.env.DOWNSTREAM_ENABLE_FILE_APPLY_DIFF = "true";
    process.env.DOWNSTREAM_ENABLE_SESSION_LOAD = "true";
    const { service, prisma, sandboxRegistry } = createServiceHarness();
    prisma.agentRun.findUnique.mockResolvedValue({
      orchestratorAgentId: 1,
      downstreamSessionId: "downstream-session-1",
    });

    const pending = service.applyFileChanges({
      sessionId: "session-1",
      runId: "run-1",
      fileChangeIds: ["change-1"],
      changes: [{ id: "change-1", path: "src/app.ts", patch: "@@ -1 +1 @@" }],
    });
    await flushMicrotasks();

    const socket = socketMock.sockets.at(-1)!;
    const load = requestFor(socket, "session/load");
    socket.trigger("acp:message", {
      jsonrpc: "2.0",
      id: load!.id,
      result: {
        sessionId: "downstream-session-1",
        sandbox: {
          baseUrl: "http://sandbox.local",
          workspaceId: "workspace-1",
          agentBranches: { 1: "agent-1" },
        },
      },
    });
    await pending;

    expect(sandboxRegistry.saveFromSessionResult).toHaveBeenCalledWith("session-1", "downstream-session-1", {
      sessionId: "downstream-session-1",
      sandbox: {
        baseUrl: "http://sandbox.local",
        workspaceId: "workspace-1",
        agentBranches: { 1: "agent-1" },
      },
    });
  });

  it("does not create a new downstream session when diff apply session load fails", async () => {
    process.env.DOWNSTREAM_ENABLE_FILE_APPLY_DIFF = "true";
    process.env.DOWNSTREAM_ENABLE_SESSION_LOAD = "true";
    const { service, prisma } = createServiceHarness();
    prisma.agentRun.findUnique.mockResolvedValue({
      orchestratorAgentId: 1,
      downstreamSessionId: "missing-downstream-session",
    });

    const pending = service.applyFileChanges({
      sessionId: "session-1",
      runId: "run-1",
      fileChangeIds: ["change-1"],
      changes: [{ id: "change-1", path: "src/app.ts", patch: "@@ -1 +1 @@" }],
    });
    await flushMicrotasks();

    const socket = socketMock.sockets.at(-1);
    expect(socket).toBeDefined();
    const load = requestFor(socket!, "session/load");
    socket!.trigger("acp:message", {
      jsonrpc: "2.0",
      id: load!.id,
      error: { code: "SESSION_NOT_FOUND", message: "SESSION_NOT_FOUND" },
    });

    await expect(pending).rejects.toThrow("SESSION_NOT_FOUND");
    expect(requestFor(socket!, "session/new")).toBeUndefined();
    expect(requestFor(socket!, "file/apply_diff")).toBeUndefined();
  });
});

const orchestrator: AgentInstanceDto = {
  id: 1,
  templateId: 1,
  name: "main-orchestrator",
  description: "主协调者",
  provider: "claude-code",
  isDefaultOrchestrator: true,
  status: "enabled",
  capabilities: ["orchestrate"],
  template: {
    id: 1,
    name: "Orchestrator",
    description: "模板描述",
    defaultProvider: "claude-code",
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
        text: "最近历史",
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

function createRunInput(runId: string, promptText: string): StartRunInput {
  return {
    sessionId: "session-1",
    runId,
    userMessageId: `message-${runId}`,
    promptText,
    orchestrator,
    mentionedAgents: [],
  };
}

function createService(options?: { gateway?: ReturnType<typeof createGateway>; events?: { append: ReturnType<typeof vi.fn> } }) {
  return createServiceHarness(options).service;
}

function createServiceHarness(options?: { gateway?: ReturnType<typeof createGateway>; events?: { append: ReturnType<typeof vi.fn> } }) {
  const prisma = createPrisma();
  const gateway = options?.gateway ?? createGateway();
  const events = options?.events ?? { append: vi.fn().mockResolvedValue({}) };
  const contextService = { buildSnapshot: vi.fn().mockResolvedValue(context) };
  const sandboxRegistry = { saveFromSessionResult: vi.fn().mockResolvedValue(undefined) };
  return {
    prisma,
    gateway,
    events,
    sandboxRegistry,
    service: new DownstreamOrchestratorService(
      prisma as any,
      events as any,
      gateway as any,
      contextService as any,
      sandboxRegistry as any,
    ),
  };
}

function createPrisma() {
  return {
    agentRun: {
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(null),
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
            id: 2,
            description: "前端成员描述",
            template: { description: "前端模板描述" },
          },
        },
        {
          agent: {
            id: 3,
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
    emitContext: vi.fn(),
    hasSessionSubscribers: vi.fn().mockReturnValue(false),
  };
}

async function startRunWithDownstreamSession(
  service: DownstreamOrchestratorService,
  input: StartRunInput,
  downstreamSessionId: string,
  extraResult: Record<string, unknown> = {},
) {
  const pending = service.startRun(input);
  await flushMicrotasks();
  const socket = socketMock.sockets.at(-1);
  expect(socket).toBeDefined();
  const request = requestFor(socket!, "session/new") ?? requestFor(socket!, "session/load");
  expect(request).toBeDefined();
  socket!.trigger("acp:message", { jsonrpc: "2.0", id: request!.id, result: { sessionId: downstreamSessionId, ...extraResult } });
  await pending;
  return socket!;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function lastPromptParams() {
  const prompts = socketMock.sockets
    .flatMap((socket) => socket.emitted)
    .filter((item) => item.event === "acp:message" && item.payload.method === "session/prompt");
  expect(prompts.length).toBeGreaterThan(0);
  return prompts.at(-1)!.payload.params;
}

function firstRequestParams(method: string) {
  const request = socketMock.sockets
    .flatMap((socket) => socket.emitted)
    .find((item) => item.event === "acp:message" && item.payload.method === method);
  expect(request).toBeDefined();
  return request!.payload.params;
}

function requestFor(socket: (typeof socketMock.sockets)[number], method: string) {
  return socket.emitted
    .filter((item) => item.event === "acp:message")
    .map((item) => item.payload)
    .find((payload) => payload.method === method);
}

function responseFor(socket: (typeof socketMock.sockets)[number], id: string | number) {
  return socket.emitted
    .filter((item) => item.event === "acp:message")
    .map((item) => item.payload)
    .find((payload) => payload.id === id && (payload.result || payload.error));
}
