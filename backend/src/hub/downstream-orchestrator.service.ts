import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type { AgentInstanceDto, DownstreamPromptInput, HubContextSnapshotDto } from "@agenthub/shared";
import { io, Socket } from "socket.io-client";
import { HubEventService } from "./event.service";
import { HubRealtimeGateway } from "./hub-realtime.gateway";
import { mapSession } from "./hub.mappers";
import { PrismaService } from "./prisma.service";

type ConnectionRecord = {
  key: string;
  socket: Socket;
  sessionId: string;
  idleTimer: NodeJS.Timeout | null;
  lastActivityAt: number;
  needsBootstrap: boolean;
};

type DownstreamEnvelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  type?: string;
  runId?: string;
  seq?: number;
  payload?: Record<string, unknown>;
  speaker?: string;
};

const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
const IDLE_RECHECK_MS = 60 * 1000;

@Injectable()
export class DownstreamOrchestratorService implements OnModuleDestroy {
  private readonly connections = new Map<string, ConnectionRecord>();

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(HubEventService)
    private readonly events: HubEventService,
    @Inject(HubRealtimeGateway)
    private readonly gateway: HubRealtimeGateway,
  ) {}

  onModuleDestroy() {
    for (const record of this.connections.values()) {
      this.clearIdleTimer(record);
      record.socket.disconnect();
    }
    this.connections.clear();
  }

  async startRun(input: {
    sessionId: string;
    runId: string;
    userMessageId: string;
    promptText: string;
    orchestrator: AgentInstanceDto;
    mentionedAgents: AgentInstanceDto[];
    context: HubContextSnapshotDto;
  }) {
    await this.prisma.agentRun.update({
      where: { id: input.runId },
      data: { status: "connecting" },
    });
    await this.events.append({
      sessionId: input.sessionId,
      runId: input.runId,
      eventType: "run.status",
      speakerAgentId: input.orchestrator.id,
      source: "agenthub_backend",
      payload: { status: "connecting" },
    });

    const downstreamUrl = process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL;
    if (!downstreamUrl) {
      await this.simulateRun(input);
      return;
    }

    try {
      const connection = await this.ensureConnection(input.sessionId, downstreamUrl, input.orchestrator);
      const promptInput = await this.buildPromptInput(input, connection.needsBootstrap);

      connection.socket.emit("acp:message", {
        jsonrpc: "2.0",
        id: `prompt-${input.runId}`,
        method: "session/prompt",
        params: promptInput,
      });
      connection.needsBootstrap = false;
      this.markDownstreamActivity(connection);

      await this.prisma.agentRun.update({
        where: { id: input.runId },
        data: { status: "running", startedAt: new Date() },
      });
      const session = await this.prisma.session.update({
        where: { id: input.sessionId },
        data: { updatedAt: new Date() },
        include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      this.gateway.emitSession(mapSession(session));
      await this.events.append({
        sessionId: input.sessionId,
        runId: input.runId,
        eventType: "run.status",
        speakerAgentId: input.orchestrator.id,
        source: "agenthub_backend",
        payload: { status: "running", downstream: "prompt_sent" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failRun(input.sessionId, input.runId, input.orchestrator.id, "DOWNSTREAM_PROMPT_FAILED", message);
    }
  }

  async cancelRun(sessionId: string, runId: string, orchestratorAgentId: string) {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: { status: "cancelled", completedAt: new Date() },
    });
    const record = this.connections.get(sessionId);
    record?.socket.emit("acp:message", {
      jsonrpc: "2.0",
      id: `cancel-${runId}`,
      method: "session/cancel",
      params: { runId },
    });
    if (record?.socket.connected) this.markDownstreamActivity(record);
    await this.events.append({
      sessionId,
      runId,
      eventType: "run.cancelled",
      speakerAgentId: orchestratorAgentId,
      payload: { status: "cancelled" },
    });
  }

  /** Push context to downstream on connect/reconnect (complete context injection) */
  async pushContext(
    sessionId: string,
    payload: {
      agents: Array<{ agentId: string; name: string; description: string; provider: number }>;
      summaryChain: Array<{ seq: number; content: string }>;
      message: string;
      recentMessages: Array<{ role: string; content: string }>;
    },
  ) {
    const record = this.connections.get(sessionId);
    if (!record?.socket.connected) return;
    record.socket.emit("acp:message", {
      jsonrpc: "2.0",
      id: `context-${sessionId}-${Date.now()}`,
      method: "session/context",
      params: {
        type: "init",
        sessionId,
        ...payload,
      },
    });
    this.markDownstreamActivity(record);
  }

  private async ensureConnection(
    sessionId: string,
    downstreamUrl: string,
    _orchestrator: AgentInstanceDto,
  ): Promise<ConnectionRecord> {
    const existing = this.connections.get(sessionId);
    if (existing?.socket.connected) {
      return existing;
    }

    if (existing) {
      existing.socket.disconnect();
      this.connections.delete(sessionId);
    }

    const socket = io(downstreamUrl, {
      transports: ["websocket"],
      reconnection: false,
    });

    const record: ConnectionRecord = {
      key: sessionId,
      socket,
      sessionId,
      idleTimer: null,
      lastActivityAt: Date.now(),
      needsBootstrap: true,
    };
    this.connections.set(sessionId, record);

    socket.on("connect", () => {
      record.needsBootstrap = true;
      socket.emit("acp:message", {
        jsonrpc: "2.0",
        id: `init-${sessionId}`,
        method: "initialize",
        params: {
          protocolVersion: "2026-05-agenthub-v1",
          clientInfo: { name: "AgentHub", version: "0.1.0" },
          capabilities: { sessionResume: true, artifacts: true, fileChangeSnapshot: true },
        },
      });
      socket.emit("acp:message", {
        jsonrpc: "2.0",
        id: `load-${sessionId}`,
        method: "session/load",
        params: {
          agenthubSessionId: sessionId,
          cwd: "/workspace",
        },
      });
      this.markDownstreamActivity(record);
    });

    socket.on("disconnect", () => {
      this.clearIdleTimer(record);
      record.needsBootstrap = true;
      if (this.connections.get(sessionId) === record) {
        this.connections.delete(sessionId);
      }
    });

    socket.on("connect_error", () => {
      // socket.io handles reconnection internally
    });

    socket.on("session/event", (event) => void this.handleDownstreamEvent(record, event as DownstreamEnvelope));
    socket.on("acp:event", (event) => void this.handleDownstreamEvent(record, event as DownstreamEnvelope));
    socket.on("acp:message", (event) => void this.handleDownstreamEvent(record, event as DownstreamEnvelope));
    socket.on("message", (event) => void this.handleDownstreamEvent(record, event as DownstreamEnvelope));

    await waitForSocket(socket);
    this.scheduleIdleDisconnectCheck(record);
    return record;
  }

  private markDownstreamActivity(record: ConnectionRecord) {
    record.lastActivityAt = Date.now();
    this.scheduleIdleDisconnectCheck(record);
  }

  private scheduleIdleDisconnectCheck(record: ConnectionRecord) {
    this.clearIdleTimer(record);
    const idleFor = Date.now() - record.lastActivityAt;
    const delay = Math.max(0, IDLE_TIMEOUT_MS - idleFor);
    record.idleTimer = setTimeout(() => {
      this.closeIfIdle(record);
    }, delay);
  }

  private closeIfIdle(record: ConnectionRecord) {
    if (this.connections.get(record.key) !== record) return;
    const idleFor = Date.now() - record.lastActivityAt;
    if (idleFor >= IDLE_TIMEOUT_MS && !this.gateway.hasSessionSubscribers(record.sessionId)) {
      record.socket.disconnect();
      this.connections.delete(record.key);
      return;
    }
    this.clearIdleTimer(record);
    const delay = idleFor >= IDLE_TIMEOUT_MS ? IDLE_RECHECK_MS : Math.max(0, IDLE_TIMEOUT_MS - idleFor);
    record.idleTimer = setTimeout(() => {
      this.closeIfIdle(record);
    }, delay);
  }

  private clearIdleTimer(record: ConnectionRecord) {
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = null;
    }
  }

  private async handleDownstreamEvent(record: ConnectionRecord, envelope: DownstreamEnvelope) {
    this.markDownstreamActivity(record);

    const params = asRecord(envelope.params ?? envelope.payload ?? envelope);
    if (envelope.method && envelope.method !== "session/event") return;
    const runId = stringValue(params.runId) ?? stringValue(envelope.runId);
    if (!runId) return;

    const eventType = stringValue(params.type) ?? stringValue(params.eventType) ?? stringValue(envelope.type);
    if (!eventType) return;
    const payload = asRecord(params.payload ?? params);

    const speaker =
      stringValue(params.speaker) ??
      stringValue(payload.speaker) ??
      stringValue(envelope.speaker) ??
      "orchestrator";

    await this.events.append({
      sessionId: record.sessionId,
      runId,
      eventType,
      speakerAgentId: speaker,
      seq: numberValue(params.seq),
      payload,
      source: "downstream_agent",
      occurredAt: new Date(),
    });

    if (eventType === "run.completed") {
      await this.completeRun(record.sessionId, runId, speaker, payload);
    }
    if (eventType === "run.failed") {
      await this.failRun(
        record.sessionId,
        runId,
        speaker,
        "DOWNSTREAM_RUN_FAILED",
        stringValue(payload.message) ?? "run failed",
      );
    }
  }

  private async simulateRun(input: {
    sessionId: string;
    runId: string;
    promptText: string;
    orchestrator: AgentInstanceDto;
    mentionedAgents: AgentInstanceDto[];
  }) {
    const speakers = input.mentionedAgents.length > 0 ? input.mentionedAgents : [
      // Default mock agents
      { id: "10000000-0000-4000-8000-000000000002", name: "frontend-agent" } as AgentInstanceDto,
      { id: "10000000-0000-4000-8000-000000000003", name: "backend-agent" } as AgentInstanceDto,
      { id: "10000000-0000-4000-8000-000000000004", name: "review-agent" } as AgentInstanceDto,
    ];

    await this.prisma.agentRun.update({
      where: { id: input.runId },
      data: { status: "running", startedAt: new Date(), downstreamSessionId: `mock-${input.sessionId}` },
    });
    await this.events.append({
      sessionId: input.sessionId,
      runId: input.runId,
      eventType: "run.status",
      speakerAgentId: input.orchestrator.id,
      source: "mock_orchestrator",
      payload: { status: "running", mode: "mock", reason: "DOWNSTREAM_ORCHESTRATOR_WS_URL is not configured" },
    });

    await sleep(250);
    await this.events.append({
      sessionId: input.sessionId,
      runId: input.runId,
      eventType: "message.delta",
      speakerAgentId: input.orchestrator.id,
      source: "mock_orchestrator",
      payload: {
        text: `已收到任务，并将按 @Agent 分工推进：${speakers.map((agent) => agent.name).join("、") || "默认团队"}。`,
      },
    });

    for (const agent of speakers.slice(0, 3)) {
      await sleep(250);
      await this.events.append({
        sessionId: input.sessionId,
        runId: input.runId,
        eventType: "message.delta",
        speakerAgentId: agent.id,
        source: "mock_orchestrator",
        payload: {
          text: `${agent.name}：基于任务"${input.promptText.slice(0, 80)}"，我会输出可落库的事件、artifact 和文件变更快照。`,
          speaker: agent.id,
        },
      });
    }

    await sleep(250);
    await this.events.append({
      sessionId: input.sessionId,
      runId: input.runId,
      eventType: "file.change",
      speakerAgentId: speakers[0]?.id ?? input.orchestrator.id,
      source: "mock_orchestrator",
      payload: {
        speaker: speakers[0]?.id ?? input.orchestrator.id,
        path: "src/app/page.tsx",
        changeType: "modified",
        language: "tsx",
        before: { content: "export default function Page(){ return <div /> }", truncated: false },
        after: { content: "export default function Page(){ return <main>AgentHub Workbench</main> }", truncated: false },
        patch: "@@ -1 +1 @@\n-export default function Page(){ return <div /> }\n+export default function Page(){ return <main>AgentHub Workbench</main> }\n",
      },
    });

    await sleep(250);
    await this.events.append({
      sessionId: input.sessionId,
      runId: input.runId,
      eventType: "artifact.upsert",
      speakerAgentId: input.orchestrator.id,
      source: "mock_orchestrator",
      payload: {
        artifactKey: "run-summary",
        kind: "markdown",
        title: "执行摘要",
        mimeType: "text/markdown; charset=utf-8",
        content: `# 执行摘要\n\n- run: ${input.runId}\n- speakers: ${speakers.map((agent) => agent.name).join(", ")}\n- mock 模式已覆盖 message.delta、file.change、artifact.upsert、run.completed。`,
        final: true,
      },
    });

    await sleep(250);
    await this.events.append({
      sessionId: input.sessionId,
      runId: input.runId,
      eventType: "message.completed",
      speakerAgentId: input.orchestrator.id,
      source: "mock_orchestrator",
      payload: { text: "本轮 mock 执行完成。接入真实下游后，该链路会复用同一套持久化与前端实时展示。" },
    });
    await this.completeRun(input.sessionId, input.runId, input.orchestrator.id, { status: "completed" });
  }

  private async buildPromptInput(
    input: {
      sessionId: string;
      runId: string;
      userMessageId: string;
      promptText: string;
      orchestrator: AgentInstanceDto;
      context: HubContextSnapshotDto;
    },
    bootstrap: boolean,
  ): Promise<DownstreamPromptInput> {
    const snapshot = input.context.snapshotJson;
    const base: DownstreamPromptInput = {
      agenthubSessionId: input.sessionId,
      runId: input.runId,
      messageId: input.userMessageId,
      agentId: input.orchestrator.id,
      mode: bootstrap ? "bootstrap" : "incremental",
      prompt: input.promptText,
      pins: snapshot.pins,
      metadata: {
        source: "agenthub",
        contextSnapshotId: input.context.id,
      },
    };

    if (!bootstrap) return base;

    return {
      ...base,
      orchestratorSystemPrompt: input.orchestrator.template?.systemPrompt ?? "",
      agents: await this.loadSessionAgentBriefs(input.sessionId, input.orchestrator.id),
      memory: {
        summary: snapshot.summary ?? "",
        retrieved: snapshot.retrieved,
      },
    };
  }

  private async loadSessionAgentBriefs(sessionId: string, orchestratorAgentId: string) {
    const participants = await this.prisma.sessionAgent.findMany({
      where: {
        sessionId,
        agentId: { not: orchestratorAgentId },
        participantRole: { not: "orchestrator" },
      },
      include: {
        agent: { include: { template: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return participants.map((participant) => ({
      agentId: participant.agent.id,
      description: participant.agent.description || participant.agent.template?.description || "",
    }));
  }

  private async completeRun(sessionId: string, runId: string, speakerAgentId: string, payload: Record<string, unknown>) {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date() },
    });
    const session = await this.prisma.session.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    await this.events.append({
      sessionId,
      runId,
      eventType: "run.completed",
      speakerAgentId,
      payload,
    });
    this.gateway.emitSession(mapSession(session));
  }

  private async failRun(sessionId: string, runId: string, speakerAgentId: string, code: string, message: string) {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: { status: "failed", errorCode: code, errorMessage: message, completedAt: new Date() },
    });
    await this.events.append({
      sessionId,
      runId,
      eventType: "run.failed",
      speakerAgentId,
      payload: { code, message },
    });
  }
}

function waitForSocket(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("downstream websocket connect timeout"));
    }, 15000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("connect_error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
