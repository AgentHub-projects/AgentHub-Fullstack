import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type { AgentInstanceDto, DownstreamPromptInput, HubContextSnapshotDto } from "@agenthub/shared";
import { io, Socket } from "socket.io-client";
import { AgentRegistryService } from "./agent-registry.service";
import { HubEventService } from "./event.service";
import { HubRealtimeGateway } from "./hub-realtime.gateway";
import { mapSession } from "./hub.mappers";
import { PrismaService } from "./prisma.service";

type ConnectionRecord = {
  key: string;
  socket: Socket;
  sessionId: string;
  orchestrator: AgentInstanceDto;
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

@Injectable()
export class DownstreamOrchestratorService implements OnModuleDestroy {
  private readonly connections = new Map<string, ConnectionRecord>();

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(AgentRegistryService)
    private readonly agents: AgentRegistryService,
    @Inject(HubEventService)
    private readonly events: HubEventService,
    @Inject(HubRealtimeGateway)
    private readonly gateway: HubRealtimeGateway,
  ) {}

  onModuleDestroy() {
    for (const record of this.connections.values()) {
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
      payload: { status: "connecting", endpointUrl: input.orchestrator.endpointUrl },
    });

    if (!input.orchestrator.endpointUrl) {
      await this.simulateRun(input);
      return;
    }

    try {
      const connection = await this.ensureConnection(input.sessionId, input.orchestrator);
      const promptInput: DownstreamPromptInput = {
        agenthubSessionId: input.sessionId,
        runId: input.runId,
        messageId: input.userMessageId,
        agentId: input.orchestrator.id,
        mentionedAgentIds: input.mentionedAgents.map((agent) => agent.id),
        mentionedAgentNames: input.mentionedAgents.map((agent) => agent.name),
        prompt: [
          { type: "text", text: input.promptText },
          { type: "text", text: input.context.promptText },
        ],
        context: input.context,
        metadata: { source: "agenthub", protocolProfile: input.orchestrator.protocolProfile },
      };

      connection.socket.emit("acp:message", {
        jsonrpc: "2.0",
        id: `prompt-${input.runId}`,
        method: "session/prompt",
        params: promptInput,
      });

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
    const record = this.connections.get(connectionKey(sessionId, orchestratorAgentId));
    record?.socket.emit("acp:message", {
      jsonrpc: "2.0",
      id: `cancel-${runId}`,
      method: "session/cancel",
      params: { runId },
    });
    await this.events.append({
      sessionId,
      runId,
      eventType: "run.cancelled",
      speakerAgentId: orchestratorAgentId,
      payload: { status: "cancelled" },
    });
  }

  private async ensureConnection(sessionId: string, orchestrator: AgentInstanceDto): Promise<ConnectionRecord> {
    const key = connectionKey(sessionId, orchestrator.id);
    const existing = this.connections.get(key);
    if (existing?.socket.connected) return existing;

    const endpointUrl = orchestrator.endpointUrl;
    if (!endpointUrl) throw new Error("orchestrator endpointUrl is empty");

    const socket = io(endpointUrl, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 5,
      auth: this.authPayload(orchestrator),
    });
    const record: ConnectionRecord = { key, socket, sessionId, orchestrator };
    this.connections.set(key, record);

    socket.on("connect", () => {
      void this.markConnected(record);
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
          agentId: orchestrator.id,
          cwd: orchestrator.sandbox.cwd ?? "/workspace",
        },
      });
    });

    socket.on("disconnect", (reason) => {
      void this.markClosed(record, reason);
    });
    socket.on("connect_error", (error) => {
      void this.markFailed(record, error.message);
    });
    socket.on("session/event", (event) => void this.handleDownstreamEvent(record, event as DownstreamEnvelope));
    socket.on("acp:event", (event) => void this.handleDownstreamEvent(record, event as DownstreamEnvelope));
    socket.on("acp:message", (event) => void this.handleDownstreamEvent(record, event as DownstreamEnvelope));
    socket.on("message", (event) => void this.handleDownstreamEvent(record, event as DownstreamEnvelope));

    await waitForSocket(socket);
    return record;
  }

  private async handleDownstreamEvent(record: ConnectionRecord, envelope: DownstreamEnvelope) {
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
      record.orchestrator.id;

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
      await this.failRun(record.sessionId, runId, speaker, "DOWNSTREAM_RUN_FAILED", stringValue(payload.message) ?? "run failed");
    }
  }

  private async simulateRun(input: {
    sessionId: string;
    runId: string;
    promptText: string;
    orchestrator: AgentInstanceDto;
    mentionedAgents: AgentInstanceDto[];
  }) {
    const speakers = input.mentionedAgents.length
      ? input.mentionedAgents
      : (await this.agents.getAgents([
          "10000000-0000-4000-8000-000000000002",
          "10000000-0000-4000-8000-000000000003",
          "10000000-0000-4000-8000-000000000004",
        ]));

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
          text: `${agent.name}：基于任务“${input.promptText.slice(0, 80)}”，我会输出可落库的事件、artifact 和文件变更快照。`,
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

  private async markConnected(record: ConnectionRecord) {
    await this.prisma.downstreamConnection.upsert({
      where: { sessionId_agentId: { sessionId: record.sessionId, agentId: record.orchestrator.id } },
      create: {
        sessionId: record.sessionId,
        agentId: record.orchestrator.id,
        endpointUrl: record.orchestrator.endpointUrl ?? "",
        status: "connected",
        connectedAt: new Date(),
      },
      update: { status: "connected", connectedAt: new Date(), closedAt: null, closeReason: null },
    });
  }

  private async markClosed(record: ConnectionRecord, reason: string) {
    await this.prisma.downstreamConnection.upsert({
      where: { sessionId_agentId: { sessionId: record.sessionId, agentId: record.orchestrator.id } },
      create: {
        sessionId: record.sessionId,
        agentId: record.orchestrator.id,
        endpointUrl: record.orchestrator.endpointUrl ?? "",
        status: "closed",
        closedAt: new Date(),
        closeReason: reason,
      },
      update: { status: "closed", closedAt: new Date(), closeReason: reason },
    });
  }

  private async markFailed(record: ConnectionRecord, reason: string) {
    await this.prisma.downstreamConnection.upsert({
      where: { sessionId_agentId: { sessionId: record.sessionId, agentId: record.orchestrator.id } },
      create: {
        sessionId: record.sessionId,
        agentId: record.orchestrator.id,
        endpointUrl: record.orchestrator.endpointUrl ?? "",
        status: "failed",
        closedAt: new Date(),
        closeReason: reason,
      },
      update: { status: "failed", closedAt: new Date(), closeReason: reason },
    });
  }

  private authPayload(agent: AgentInstanceDto) {
    if (agent.authType === "bearer" && agent.authSecretRef) {
      const token = process.env[agent.authSecretRef] ?? agent.authSecretRef;
      return { token };
    }
    return undefined;
  }
}

function connectionKey(sessionId: string, orchestratorAgentId: string) {
  return `${sessionId}:${orchestratorAgentId}`;
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
