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
const RECOVERY_TIMEOUT_MS = 3000;

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
      record.closing = true;
      record.socket.disconnect();
    }
    this.connections.clear();
  }

  async startRun(input: {
    sessionId: string;
    runId: string;
    userMessageId: string;
    promptText: string;
    messageContext?: Record<string, unknown>;
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
      const reusableDownstreamSessionId = await this.findReusableDownstreamSessionId(input.sessionId);
      const connection = await this.ensureConnection(input.sessionId, downstreamUrl, input.orchestrator, {
        downstreamSessionId: reusableDownstreamSessionId,
      });
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
        data: {
          status: "running",
          startedAt: new Date(),
          downstreamSessionId,
          downstreamRunId: input.runId,
        },
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
    if (record?.activeRunId === runId) record.activeRunId = undefined;
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
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (session) this.gateway.emitSession(mapSession(session));
  }

  async closeSession(sessionId: string) {
    const record = this.connections.get(sessionId);
    if (!record) return;
    this.clearIdleTimer(record);
    record.closing = true;
    record.socket.disconnect();
    this.connections.delete(sessionId);
  }

  async applyFileChanges(input: {
    sessionId: string;
    runId: string;
    fileChangeIds: string[];
    changes: Array<{ id: string; path: string; patch?: string | null; beforeContent?: string | null; afterContent?: string | null }>;
  }) {
    const record = this.connections.get(input.sessionId);
    if (!record?.socket.connected) {
      throw new Error("DOWNSTREAM_NOT_CONNECTED");
    }
    record.socket.emit("acp:message", {
      jsonrpc: "2.0",
      id: record.nextId++,
      method: "file/apply_diff",
      params: {
        runId: input.runId,
        fileChangeIds: input.fileChangeIds,
        changes: input.changes,
      },
    });
    this.markDownstreamActivity(record);
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

  notifyPinUpdated(sessionId: string, payload: { messageId: string; partId?: string; pinned: boolean }) {
    this.sendSessionDelta(sessionId, "pin.updated", payload);
  }

  notifyMemberAdded(sessionId: string, payload: { agentId: AgentId; description: string }) {
    this.sendSessionDelta(sessionId, "member.added", payload);
  }

  notifyMemberDeleted(sessionId: string, payload: { agentId: AgentId }) {
    this.sendSessionDelta(sessionId, "member.deleted", payload);
  }

  private sendSessionDelta(sessionId: string, type: string, payload: Record<string, unknown>) {
    const record = this.connections.get(sessionId);
    if (!record?.socket.connected) return;
    record.socket.emit("acp:message", {
      jsonrpc: "2.0",
      id: record.nextId++,
      method: "session/context_delta",
      params: {
        sessionId: record.downstreamSessionId,
        agenthubSessionId: sessionId,
        type,
        ...payload,
      },
    });
    this.markDownstreamActivity(record);
  }

  private async ensureConnection(
    sessionId: string,
    downstreamUrl: string,
    agent: AgentInstanceDto,
    options: { downstreamSessionId?: string | null; activeRunId?: string; activeOrchestratorAgentId?: AgentId } = {},
  ): Promise<ConnectionRecord> {
    const existing = this.connections.get(sessionId);
    if (existing?.socket.connected) {
      return existing;
    }

    if (existing) {
      existing.closing = true;
      existing.socket.disconnect();
      this.connections.delete(sessionId);
    }

    const socket = io(downstreamUrl, {
      transports: ["websocket"],
      reconnection: false,
    });

    let resolveReady!: (id: string) => void;
    let rejectReady!: (error: Error) => void;
    const downstreamReady = new Promise<string>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const record: ConnectionRecord = {
      key: sessionId,
      socket,
      sessionId,
      downstreamSessionId: options.downstreamSessionId ?? undefined,
      downstreamReady,
      resolveDownstreamReady: resolveReady,
      rejectDownstreamReady: rejectReady,
      activeRunId: options.activeRunId,
      activeOrchestratorAgentId: options.activeOrchestratorAgentId,
      idleTimer: null,
      lastActivityAt: Date.now(),
      needsBootstrap: !options.downstreamSessionId,
      nextId: 1,
      pendingRequests: new Map(),
    };
    this.connections.set(sessionId, record);

    socket.on("connect", () => {
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
      const loadSessionId = record.downstreamSessionId;
      void this.requestDownstream(
        record,
        loadSessionId ? "session/load" : "session/new",
        loadSessionId
          ? { sessionId: loadSessionId }
          : {
              _meta: { agentId: agent.id },
              mcpServers: [],
            },
      )
        .then((result) => {
          const resultSessionId = stringValue(result.sessionId) ?? loadSessionId;
          if (!resultSessionId) throw new Error("DOWNSTREAM_SESSION_ID_MISSING");
          record.downstreamSessionId = resultSessionId;
          record.needsBootstrap = !loadSessionId;
          record.loadedActiveRun = readActiveRun(result);
          record.resolveDownstreamReady?.(resultSessionId);
        })
        .catch((error) => {
          if (loadSessionId && !record.activeRunId) {
            record.downstreamSessionId = undefined;
            record.needsBootstrap = true;
            void this.requestDownstream(record, "session/new", {
              _meta: { agentId: agent.id },
              mcpServers: [],
            })
              .then((result) => {
                const resultSessionId = stringValue(result.sessionId);
                if (!resultSessionId) throw new Error("DOWNSTREAM_SESSION_ID_MISSING");
                record.downstreamSessionId = resultSessionId;
                record.loadedActiveRun = undefined;
                record.resolveDownstreamReady?.(resultSessionId);
              })
              .catch((fallbackError) => {
                record.rejectDownstreamReady?.(
                  fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)),
                );
              });
            return;
          }
          record.rejectDownstreamReady?.(error instanceof Error ? error : new Error(String(error)));
        });
      this.markDownstreamActivity(record);
    });

    socket.on("acp:message", (msg: DownstreamEnvelope) => {
      void this.handleDownstreamEvent(record, msg);
    });

    socket.on("disconnect", () => {
      this.clearIdleTimer(record);
      record.needsBootstrap = true;
      for (const [id, pending] of record.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("DOWNSTREAM_DISCONNECTED"));
        record.pendingRequests.delete(id);
      }
      if (this.connections.get(sessionId) === record) {
        this.connections.delete(sessionId);
      }
      if (record.activeRunId && !record.closing) {
        void this.recoverActiveRunAfterDisconnect({
          sessionId,
          runId: record.activeRunId,
          orchestratorAgentId: record.activeOrchestratorAgentId ?? 1,
          downstreamSessionId: record.downstreamSessionId,
          downstreamUrl,
        });
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
    if (record.activeRunId) {
      this.clearIdleTimer(record);
      record.idleTimer = setTimeout(() => {
        this.closeIfIdle(record);
      }, IDLE_RECHECK_MS);
      return;
    }
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

  private requestDownstream(
    record: ConnectionRecord,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = RECOVERY_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const id = record.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.pendingRequests.delete(id);
        reject(new Error(`${method.toUpperCase()}_TIMEOUT`));
      }, timeoutMs);
      record.pendingRequests.set(id, { resolve, reject, timer });
      record.socket.emit("acp:message", {
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  private async handleDownstreamEvent(record: ConnectionRecord, envelope: DownstreamEnvelope) {
    this.markDownstreamActivity(record);

    const envelopeId = typeof envelope.id === "number" || typeof envelope.id === "string" ? envelope.id : undefined;
    const requestId =
      typeof envelopeId === "number"
        ? envelopeId
        : typeof envelopeId === "string" && /^\d+$/.test(envelopeId)
          ? Number(envelopeId)
          : null;
    if (requestId && record.pendingRequests.has(requestId)) {
      const pending = record.pendingRequests.get(requestId)!;
      record.pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      if (envelope.error) {
        const message = typeof envelope.error === "string" ? envelope.error : envelope.error.message ?? "DOWNSTREAM_REQUEST_FAILED";
        pending.reject(new Error(message));
      } else {
        pending.resolve(asRecord(envelope.result));
      }
      return;
    }

    const inboundRequestId = envelopeId;
    const params = asRecord(envelope.params ?? envelope.payload ?? envelope);

    // Handle session/update (agent message chunks from downstream)
    if (envelope.method === "session/update") {
      try {
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
        this.ackDownstreamEvent(record, inboundRequestId);
      } catch (error) {
        this.rejectDownstreamEvent(record, inboundRequestId, error);
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
    if (!runId) {
      this.rejectDownstreamEvent(record, inboundRequestId, new Error("RUN_ID_REQUIRED"));
      return;
    }

    // Drop events for runs that have been cancelled
    if (await this.isRunCancelled(runId)) {
      this.rejectDownstreamEvent(record, inboundRequestId, new Error("RUN_ALREADY_CANCELLED"));
      return;
    }

    const eventType = stringValue(params.type) ?? stringValue(params.eventType) ?? stringValue(envelope.type);
    if (!eventType) {
      this.rejectDownstreamEvent(record, inboundRequestId, new Error("EVENT_TYPE_REQUIRED"));
      return;
    }
    const payload = asRecord(params.payload ?? params);

    const speakerAgentId =
      agentIdValue(params.speaker) ??
      agentIdValue(payload.speaker) ??
      agentIdValue(envelope.speaker);

    try {
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
        await this.markRunCompleted(record.sessionId, runId);
      }
      if (eventType === "run.failed") {
        await this.markRunFailed(
          record.sessionId,
          runId,
          "DOWNSTREAM_RUN_FAILED",
          stringValue(payload.message) ?? "run failed",
        );
      }
      this.ackDownstreamEvent(record, inboundRequestId);
    } catch (error) {
      this.rejectDownstreamEvent(record, inboundRequestId, error);
    }
  }

  private ackDownstreamEvent(record: ConnectionRecord, id?: string | number) {
    if (id === undefined) return;
    record.socket.emit("acp:message", {
      jsonrpc: "2.0",
      id,
      result: { ok: true },
    });
  }

  private rejectDownstreamEvent(record: ConnectionRecord, id: string | number | undefined, error: unknown) {
    if (id === undefined) return;
    const message = error instanceof Error ? error.message : String(error);
    record.socket.emit("acp:message", {
      jsonrpc: "2.0",
      id,
      error: {
        code: errorCode(message),
        message,
      },
    });
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
      eventType: "message.completed",
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
        eventType: "message.completed",
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
        content: `# 执行摘要\n\n- run: ${input.runId}\n- speakers: ${speakers.map((agent) => agent.name).join(", ")}\n- mock 模式已覆盖 message.completed、file.change、artifact.upsert、run.completed。`,
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

  private async findReusableDownstreamSessionId(sessionId: string) {
    const agentRunModel = this.prisma.agentRun as any;
    if (typeof agentRunModel.findFirst !== "function") return null;
    const run = await agentRunModel.findFirst({
      where: {
        sessionId,
        downstreamSessionId: { not: null },
      },
      orderBy: { createdAt: "desc" },
      select: { downstreamSessionId: true },
    });
    return run?.downstreamSessionId ?? null;
  }

  private async recoverActiveRunAfterDisconnect(input: {
    sessionId: string;
    runId: string;
    orchestratorAgentId: AgentId;
    downstreamSessionId?: string;
    downstreamUrl: string;
  }) {
    const agentRunModel = this.prisma.agentRun as any;
    if (typeof agentRunModel.findUnique !== "function") return;
    const run = await agentRunModel.findUnique({ where: { id: input.runId } });
    if (!run || !isActiveRunStatus(run.status)) return;
    if (!input.downstreamSessionId) {
      await this.failRun(
        input.sessionId,
        input.runId,
        input.orchestratorAgentId,
        "DOWNSTREAM_DISCONNECTED",
        "downstream disconnected without a reusable session",
      );
      return;
    }

    try {
      const record = await this.ensureConnection(
        input.sessionId,
        input.downstreamUrl,
        { id: input.orchestratorAgentId } as AgentInstanceDto,
        {
          downstreamSessionId: input.downstreamSessionId,
          activeRunId: input.runId,
          activeOrchestratorAgentId: input.orchestratorAgentId,
        },
      );
      await record.downstreamReady;
      const status = await this.readRecoveredRunStatus(record, input.runId);
      if (status === "completed" || status === "ready" || status === "success") {
        await this.completeRun(input.sessionId, input.runId, input.orchestratorAgentId, {
          status: "completed",
          recovered: true,
        });
        return;
      }
      if (status === "failed" || status === "error") {
        await this.failRun(
          input.sessionId,
          input.runId,
          input.orchestratorAgentId,
          "DOWNSTREAM_RUN_FAILED",
          "downstream run failed during recovery",
        );
        return;
      }
      await this.prisma.agentRun.update({
        where: { id: input.runId },
        data: { status: "running", downstreamSessionId: input.downstreamSessionId },
      });
      await this.events.append({
        sessionId: input.sessionId,
        runId: input.runId,
        eventType: "run.status",
        speakerAgentId: input.orchestratorAgentId,
        source: "agenthub_backend",
        payload: { status: "running", downstream: "recovered" },
      });
      const session = await this.prisma.session.findUnique({
        where: { id: input.sessionId },
        include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      if (session) this.gateway.emitSession(mapSession(session));
    } catch (error) {
      await this.failRun(
        input.sessionId,
        input.runId,
        input.orchestratorAgentId,
        "DOWNSTREAM_DISCONNECTED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async readRecoveredRunStatus(record: ConnectionRecord, runId: string) {
    if (record.loadedActiveRun?.runId) {
      if (record.loadedActiveRun.runId !== runId) throw new Error("DOWNSTREAM_ACTIVE_RUN_MISMATCH");
      return record.loadedActiveRun.status ?? "running";
    }
    const result = await this.requestDownstream(record, "run/status", { runId });
    const statusRun = asRecord(result.run ?? result.activeRun ?? result);
    const statusRunId = stringValue(statusRun.runId) ?? stringValue(statusRun.id);
    if (statusRunId && statusRunId !== runId) throw new Error("DOWNSTREAM_RUN_STATUS_MISMATCH");
    return stringValue(statusRun.status) ?? "running";
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

  private async markRunCompleted(sessionId: string, runId: string) {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date() },
    });
    const record = this.connections.get(sessionId);
    if (record?.activeRunId === runId) record.activeRunId = undefined;
    const session = await this.prisma.session.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    this.gateway.emitSession(mapSession(session));
  }

  private async markRunFailed(sessionId: string, runId: string, code: string, message: string) {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: { status: "failed", errorCode: code, errorMessage: message, completedAt: new Date() },
    });
    const record = this.connections.get(sessionId);
    if (record?.activeRunId === runId) record.activeRunId = undefined;
    if (typeof this.prisma.session.findUnique === "function") {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      if (session) this.gateway.emitSession(mapSession(session));
    }
  }

  private async buildPromptInput(
    input: {
      sessionId: string;
      runId: string;
      userMessageId: string;
      promptText: string;
      messageContext?: Record<string, unknown>;
      orchestrator: AgentInstanceDto;
      mentionedAgents: AgentInstanceDto[];
      context?: HubContextSnapshotDto | null;
    },
    downstreamSessionId: string,
    bootstrap: boolean,
  ) {
    const snapshot = input.context?.snapshotJson;

    const base = {
      sessionId: downstreamSessionId,
      runId: input.runId,
      agenthubSessionId: input.sessionId,
      messageId: input.userMessageId,
      agentId: input.orchestrator.id,
      prompt: [{ text: input.promptText, type: "text" }],
      messageContext: input.messageContext ?? {},
    };

    if (!bootstrap) {
      return {
        ...base,
        promptMode: "incremental",
      };
    }

    const systemPrompt = input.orchestrator.template?.systemPrompt;
    const agents = await this.loadSessionAgentBriefs(input.sessionId, input.orchestrator.id);

    return {
      ...base,
      promptMode: "bootstrap",
      contextSnapshotId: input.context?.id ?? null,
      ...(systemPrompt ? { orchestratorSystemPrompt: systemPrompt } : {}),
      ...(agents.length > 0 ? { agents } : {}),
      pins: snapshot?.pins ?? [],
      memory: {
        summary: snapshot?.summary ?? "",
        retrieved: snapshot?.retrieved ?? [],
      },
    };
  }

  private async loadSessionAgentBriefs(sessionId: string, orchestratorAgentId: AgentId) {
    const participants = await this.prisma.sessionAgent.findMany({
      where: {
        sessionId,
        agentId: { not: orchestratorAgentId },
        participantRole: "member",
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
    const record = this.connections.get(sessionId);
    if (record?.activeRunId === runId) record.activeRunId = undefined;
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
    const record = this.connections.get(sessionId);
    if (record?.activeRunId === runId) record.activeRunId = undefined;
    await this.events.append({
      sessionId,
      runId,
      eventType: "run.failed",
      speakerAgentId,
      payload: { code, message },
    });
    if (typeof this.prisma.session.findUnique === "function") {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      if (session) this.gateway.emitSession(mapSession(session));
    }
  }
}

function agentIdValue(value: unknown): AgentId | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function isActiveRunStatus(status: string) {
  return status === "queued" || status === "context_building" || status === "connecting" || status === "running";
}

function readActiveRun(result: Record<string, unknown>) {
  const activeRun = asRecord(result.activeRun ?? result.run);
  const runId =
    stringValue(activeRun.runId) ??
    stringValue(activeRun.id) ??
    stringValue(result.activeRunId) ??
    stringValue(result.runId);
  const status = stringValue(activeRun.status) ?? stringValue(result.activeRunStatus) ?? stringValue(result.status);
  return runId || status ? { runId, status } : undefined;
}

function errorCode(message: string) {
  return /^[A-Z0-9_]+$/.test(message) ? message : "DOWNSTREAM_EVENT_FAILED";
}
