import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type { AgentId, AgentInstanceDto, HubContextSnapshotDto } from "@agenthub/shared";
import { io } from "socket.io-client";
import { HubEventService } from "./event.service";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { mapSession } from "../mappers/hub.mappers";
import { PrismaService } from "./prisma.service";
import { HubContextService } from "./context.service";
import type { ConnectionRecord, DownstreamEnvelope } from "../types/downstream-orchestrator.types";
import { asRecord, numberValue, sleep, stringValue, waitForSocket } from "../utils/downstream-orchestrator.utils";

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
    @Inject(HubContextService)
    private readonly context: HubContextService,
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
      const downstreamSessionId = await connection.downstreamReady;
      const needsBootstrap = connection.needsBootstrap;
      const contextSnapshot = needsBootstrap ? await this.createBootstrapSnapshot(input) : null;
      const promptInput = await this.buildPromptInput(
        { ...input, context: contextSnapshot },
        downstreamSessionId!,
        needsBootstrap,
      );

      connection.activeRunId = input.runId;
      connection.activeOrchestratorAgentId = input.orchestrator.id;
      connection.socket.emit("acp:message", {
        jsonrpc: "2.0",
        id: connection.nextId++,
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

  async cancelRun(sessionId: string, runId: string, orchestratorAgentId: AgentId) {
    // Skip if the run is already in a terminal state
    const existing = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (!existing || existing.status === "cancelled" || existing.status === "completed" || existing.status === "failed") {
      return;
    }

    await this.prisma.agentRun.update({
      where: { id: runId },
      data: { status: "cancelled", completedAt: new Date() },
    });
    const record = this.connections.get(sessionId);
    record?.socket.emit("acp:message", {
      jsonrpc: "2.0",
      id: record.nextId++,
      method: "session/cancel",
      params: { runId },
    });
    if (record?.socket.connected) this.markDownstreamActivity(record);
    await this.events.append({
      sessionId,
      runId,
      eventType: "run.cancelled",
      speakerAgentId: orchestratorAgentId,
      source: "agenthub_backend",
      payload: { status: "cancelled" },
    });
  }

  async closeSession(sessionId: string) {
    const record = this.connections.get(sessionId);
    if (!record) return;
    this.clearIdleTimer(record);
    record.socket.disconnect();
    this.connections.delete(sessionId);
  }

  /** Push context to downstream on connect/reconnect (complete context injection) */
  async pushContext(
    sessionId: string,
    payload: {
      agents: Array<{ agentId: AgentId; name: string; description: string; provider: string }>;
      summaryChain: Array<{ seq: number; content: string }>;
      message: string;
      recentMessages: Array<{ role: string; content: string }>;
    },
  ) {
    const record = this.connections.get(sessionId);
    if (!record?.socket.connected) return;
    record.socket.emit("acp:message", {
      jsonrpc: "2.0",
      id: record.nextId++,
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

    let resolveReady!: (id: string) => void;
    const downstreamReady = new Promise<string>((resolve) => {
      resolveReady = resolve;
    });

    const record: ConnectionRecord = {
      key: sessionId,
      socket,
      sessionId,
      downstreamReady,
      resolveDownstreamReady: resolveReady,
      idleTimer: null,
      lastActivityAt: Date.now(),
      needsBootstrap: true,
      nextId: 1,
    };
    this.connections.set(sessionId, record);

    socket.on("connect", () => {
      record.needsBootstrap = true;
      // ACP v1 initialize
      socket.emit("acp:message", {
        jsonrpc: "2.0",
        id: record.nextId++,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        },
      });
      // ACP v1 session/new
      socket.emit("acp:message", {
        jsonrpc: "2.0",
        id: record.nextId++,
        method: "session/new",
        params: {
          _meta: { agentId: "orchestrator" },
          mcpServers: [],
        },
      });
      this.markDownstreamActivity(record);
    });

    // Capture session/new response to get downstream session ID
    socket.on("acp:message", (msg: DownstreamEnvelope) => {
      if (msg.result?.sessionId) {
        record.downstreamSessionId = stringValue(msg.result.sessionId);
        if (record.downstreamSessionId) {
          record.resolveDownstreamReady?.(record.downstreamSessionId);
        }
        return;
      }
      void this.handleDownstreamEvent(record, msg);
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

    // Handle session/update (agent message chunks from downstream)
    if (envelope.method === "session/update") {
      const update = params.update;
      const content = asRecord(typeof update === "object" ? update : {});
      const text = stringValue(content.text) ?? stringValue((content as any).content?.text);
      const sessionUpdate = stringValue((content as any).sessionUpdate);
      const runId = record.activeRunId;
      if (text && runId) {
        const meta = asRecord(params._meta ?? (content as any)._meta);
        const speaker = stringValue(meta.agentId) ?? "agent";
        const speakerAgentId = agentIdValue(meta.agentId);
        await this.events.append({
          sessionId: record.sessionId,
          runId,
          eventType: "message.delta",
          speakerAgentId,
          source: "downstream_agent",
          payload: { text, speaker },
        });
        if (sessionUpdate === "agent_message_stop" || sessionUpdate === "stop") {
          await this.events.append({
            sessionId: record.sessionId,
            runId,
            eventType: "message.completed",
            speakerAgentId,
            source: "downstream_agent",
            payload: { text, speaker },
          });
        }
      }
      return;
    }

    // Handle JSON-RPC result (e.g. prompt completion)
    if (envelope.result) {
      const runId = record.activeRunId;
      const result = asRecord(envelope.result);
      if (result.stopReason && runId) {
        await this.completeRun(record.sessionId, runId, record.activeOrchestratorAgentId ?? 1, { status: "completed", stopReason: result.stopReason });
      }
      return;
    }

    // Legacy session/event handling
    if (envelope.method && envelope.method !== "session/event") return;
    const runId = stringValue(params.runId) ?? stringValue(envelope.runId);
    if (!runId) return;

    // Drop events for runs that have been cancelled
    if (await this.isRunCancelled(runId)) return;

    const eventType = stringValue(params.type) ?? stringValue(params.eventType) ?? stringValue(envelope.type);
    if (!eventType) return;
    const payload = asRecord(params.payload ?? params);

    const speakerAgentId =
      agentIdValue(params.speaker) ??
      agentIdValue(payload.speaker) ??
      agentIdValue(envelope.speaker);

    await this.events.append({
      sessionId: record.sessionId,
      runId,
      eventType,
      speakerAgentId,
      seq: numberValue(params.seq),
      payload,
      source: "downstream_agent",
      occurredAt: new Date(),
    });

    if (eventType === "run.completed") {
      await this.completeRun(record.sessionId, runId, speakerAgentId ?? record.activeOrchestratorAgentId ?? 1, payload);
    }
    if (eventType === "run.failed") {
      await this.failRun(
        record.sessionId,
        runId,
        speakerAgentId ?? record.activeOrchestratorAgentId ?? 1,
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
      { id: 2, name: "frontend-agent" } as AgentInstanceDto,
      { id: 3, name: "backend-agent" } as AgentInstanceDto,
      { id: 4, name: "review-agent" } as AgentInstanceDto,
    ];

    // Check if already cancelled before starting
    if (await this.isRunCancelled(input.runId)) return;

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
    if (await this.isRunCancelled(input.runId)) return;
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
      if (await this.isRunCancelled(input.runId)) return;
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
    if (await this.isRunCancelled(input.runId)) return;
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
    if (await this.isRunCancelled(input.runId)) return;
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
    if (await this.isRunCancelled(input.runId)) return;
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

  private async isRunCancelled(runId: string): Promise<boolean> {
    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    return run?.status === "cancelled";
  }

  private async createBootstrapSnapshot(input: {
    sessionId: string;
    runId: string;
    promptText: string;
    mentionedAgents: AgentInstanceDto[];
  }) {
    await this.prisma.agentRun.update({
      where: { id: input.runId },
      data: { status: "context_building" },
    });
    await this.events.append({
      sessionId: input.sessionId,
      runId: input.runId,
      eventType: "run.status",
      source: "agenthub_backend",
      payload: { status: "context_building", reason: "bootstrap" },
    });

    const contextSnapshot = await this.context.buildSnapshot({
      sessionId: input.sessionId,
      runId: input.runId,
      promptText: input.promptText,
      mentionedAgents: input.mentionedAgents,
    });
    await this.prisma.agentRun.update({
      where: { id: input.runId },
      data: { contextSnapshotId: contextSnapshot.id },
    });
    this.gateway.emitContext(input.sessionId, contextSnapshot);
    return contextSnapshot;
  }

  private async buildPromptInput(
    input: {
      sessionId: string;
      runId: string;
      userMessageId: string;
      promptText: string;
      orchestrator: AgentInstanceDto;
      mentionedAgents: AgentInstanceDto[];
      context?: HubContextSnapshotDto | null;
    },
    downstreamSessionId: string,
    bootstrap: boolean,
  ) {
    const snapshot = input.context?.snapshotJson;

    // Build a comprehensive prompt that embeds all context
    const sections: string[] = [];

    if (bootstrap) {
      const systemPrompt = input.orchestrator.template?.systemPrompt;
      if (systemPrompt) {
        sections.push(`## System\n${systemPrompt}`);
      }

      const agents = await this.loadSessionAgentBriefs(input.sessionId, input.orchestrator.id);
      if (agents.length > 0) {
        sections.push(`## Available Agents\n${agents.map((a) => `- ${a.agentId}: ${a.description}`).join("\n")}`);
      }

      if (snapshot?.summary) {
        sections.push(`## Context Summary\n${snapshot.summary}`);
      }

      if (snapshot?.pins?.length) {
        sections.push(`## Pinned\n${snapshot.pins.map((p) => `- [${p.kind}] ${p.text}`).join("\n")}`);
      }
    }

    sections.push(`## User Message\n${input.promptText}`);

    const promptText = sections.join("\n\n");

    return {
      sessionId: downstreamSessionId,
      prompt: [{ text: promptText, type: "text" }],
    };
  }

  private async loadSessionAgentBriefs(sessionId: string, orchestratorAgentId: AgentId) {
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

  private async completeRun(sessionId: string, runId: string, speakerAgentId: AgentId, payload: Record<string, unknown>) {
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

  private async failRun(sessionId: string, runId: string, speakerAgentId: AgentId, code: string, message: string) {
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

function agentIdValue(value: unknown): AgentId | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
