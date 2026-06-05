import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import type { AgentId, AgentInstanceDto, HubContextSnapshotDto } from "@agenthub/shared";
import { io } from "socket.io-client";
import Redis from "ioredis";
import { HubEventService } from "./event.service";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { mapSession } from "../mappers/hub.mappers";
import { PrismaService } from "./prisma.service";
import { HubContextService } from "./context.service";
import { DownstreamSandboxRegistryService } from "./downstream-sandbox-registry.service";
import type { ConnectionRecord, DownstreamEnvelope } from "../types/downstream-orchestrator.types";
import { AcpConnection } from "./acp-connection";
import { asRecord, numberValue, sleep, stringValue, waitForSocket } from "../utils/downstream-orchestrator.utils";

type StartRunInput = {
  sessionId: string;
  runId: string;
  userMessageId: string;
  promptText: string;
  messageContext?: Record<string, unknown>;
  orchestrator: AgentInstanceDto;
  mentionedAgents: AgentInstanceDto[];
};

const IDLE_TIMEOUT_SECONDS = 60 * 60; // 1 hour
const IDLE_RECHECK_MS = 60 * 1000;
const RECOVERY_TIMEOUT_MS = 3000;
const PROMPT_RESPONSE_GRACE_MS = 50;
const ENABLE_CONTEXT_DELTA = "DOWNSTREAM_ENABLE_CONTEXT_DELTA";
const ENABLE_FILE_APPLY_DIFF = "DOWNSTREAM_ENABLE_FILE_APPLY_DIFF";

/** 下游编排服务：通过 Socket.IO ACP 协议与下游 Agent 通信，管理连接生命周期和运行编排 */
@Injectable()
export class DownstreamOrchestratorService implements OnModuleDestroy {
  private readonly logger = new Logger(DownstreamOrchestratorService.name);
  private readonly connections = new Map<string, ConnectionRecord>();

  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(HubEventService)
    private readonly events: HubEventService,
    @Inject(HubRealtimeGateway)
    private readonly gateway: HubRealtimeGateway,
    @Inject(HubContextService)
    private readonly context: HubContextService,
    @Optional()
    @Inject(DownstreamSandboxRegistryService)
    private readonly sandboxRegistry?: DownstreamSandboxRegistryService,
  ) {
    this.redis.on("error", () => undefined);
  }

  /** 模块销毁时断开所有下游 WebSocket 连接 */
  onModuleDestroy() {
    for (const record of this.connections.values()) {
      this.clearIdleTimer(record);
      record.closing = true;
      record.acp.close();
    }
    this.connections.clear();
    this.redis.disconnect();
  }

  /** 启动运行：建立连接→构建上下文快照→发送 session/prompt */
  async startRun(input: StartRunInput) {
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
      this.logger.log(`[startRun] runId=${input.runId} sessionId=${input.sessionId} 连接下游 ${downstreamUrl}`);
      await this.dispatchPrompt(input, downstreamUrl, { allowSessionNewFallback: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failRun(input.sessionId, input.runId, input.orchestrator.id, "DOWNSTREAM_PROMPT_FAILED", message);
    }
  }

  /** 取消运行：更新状态，发送 session/cancel，跳过已终止的 run */
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
    const cancelParams = { sessionId: record?.downstreamSessionId, runId, _meta: { source: "agenthub", agenthubSessionId: sessionId, runId } };
    this.logger.log(`[发送JSON] session/cancel: ${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: cancelParams })}`);
    record?.acp.notify("session/cancel", cancelParams);
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

  /** 为文件面板刷新下游session（发送 session/new 获取新ID并持久化） */
  async refreshFilesystemSession(sessionId: string): Promise<string | null> {
    const downstreamUrl = process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL;
    if (!downstreamUrl) return null;
    try {
      this.logger.log(`[filesystem.refresh] sessionId=${sessionId} 发送session/new`);
      const connection = await this.ensureConnection(sessionId, downstreamUrl, { id: 1 } as AgentInstanceDto, { forceSessionNew: true });
      const newSessionId = await connection.downstreamReady;
      if (newSessionId) {
        await this.persistSessionDownstreamId(sessionId, newSessionId);
        this.logger.log(`[filesystem.refresh] sessionId=${sessionId} newDownstreamSessionId=${newSessionId}`);
        return newSessionId;
      }
    } catch (error) {
      this.logger.warn(`[filesystem.refresh] 失败 ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }

  /** 关闭会话对应的下游连接 */
  async closeSession(sessionId: string) {
    const record = this.connections.get(sessionId);
    if (!record) return;
    this.clearIdleTimer(record);
    record.closing = true;
    record.acp.close();
    this.connections.delete(sessionId);
  }

  /** 发送 file/apply_diff ACP 消息应用文件变更 */
  async applyFileChanges(input: {
    sessionId: string;
    runId: string;
    fileChangeIds: string[];
    changes: Array<{ id: string; path: string; patch?: string | null; beforeContent?: string | null; afterContent?: string | null }>;
  }) {
    if (!downstreamFeatureEnabled(ENABLE_FILE_APPLY_DIFF)) {
      throw new Error("DOWNSTREAM_APPLY_NOT_SUPPORTED");
    }
    const record = await this.ensureApplyConnection(input.sessionId, input.runId);
    const downstreamSessionId = await (record.downstreamReady ?? Promise.resolve(record.downstreamSessionId));
    if (!downstreamSessionId) throw new Error("DOWNSTREAM_SESSION_NOT_FOUND");
    record.acp.notify("file/apply_diff", {
      sessionId: downstreamSessionId,
      fileChangeIds: input.fileChangeIds,
      changes: input.changes,
      _meta: {
        source: "agenthub",
        agenthubSessionId: input.sessionId,
        runId: input.runId,
      },
    });
    this.markDownstreamActivity(record);
  }

  /** 确保有可用的下游连接用于 apply diff */
  private async ensureApplyConnection(sessionId: string, runId: string) {
    const existing = this.connections.get(sessionId);
    if (existing?.socket.connected) return existing;

    const downstreamUrl = process.env.DOWNSTREAM_ORCHESTRATOR_WS_URL;
    if (!downstreamUrl) throw new Error("DOWNSTREAM_NOT_CONNECTED");

    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { orchestratorAgentId: true, downstreamSessionId: true },
    });
    if (!run) throw new Error("RUN_NOT_FOUND");

    const downstreamSessionId = run.downstreamSessionId ?? await this.readSessionDownstreamId(sessionId);
    if (!downstreamSessionId) throw new Error("DOWNSTREAM_SESSION_NOT_FOUND");

    const record = await this.ensureConnection(
      sessionId,
      downstreamUrl,
      { id: run.orchestratorAgentId } as AgentInstanceDto,
      {
        downstreamSessionId,
      },
    );
    const loadedSessionId = await (record.downstreamReady ?? Promise.resolve(record.downstreamSessionId));
    if (!loadedSessionId) throw new Error("DOWNSTREAM_SESSION_NOT_FOUND");
    return record;
  }

  /** 通知下游置顶状态更新 */
  notifyPinUpdated(sessionId: string, payload: { messageId: string; partId?: string; pinned: boolean }) {
    if (downstreamFeatureEnabled(ENABLE_CONTEXT_DELTA)) this.sendSessionDelta(sessionId, "pin.updated", payload);
  }

  /** 通知下游成员已加入 */
  notifyMemberAdded(sessionId: string, payload: { agentId: AgentId; description: string }) {
    if (downstreamFeatureEnabled(ENABLE_CONTEXT_DELTA)) this.sendSessionDelta(sessionId, "member.added", payload);
  }

  /** 通知下游成员已离开 */
  notifyMemberDeleted(sessionId: string, payload: { agentId: AgentId }) {
    if (downstreamFeatureEnabled(ENABLE_CONTEXT_DELTA)) this.sendSessionDelta(sessionId, "member.deleted", payload);
  }

  /** 发送 session/context_delta 给下游 */
  private sendSessionDelta(sessionId: string, type: string, payload: Record<string, unknown>) {
    const record = this.connections.get(sessionId);
    if (!record?.socket.connected) return;
    record.acp.notify("session/context_delta", {
      sessionId: record.downstreamSessionId,
      type,
      ...payload,
      _meta: {
        source: "agenthub",
        agenthubSessionId: sessionId,
      },
    });
    this.markDownstreamActivity(record);
  }

  /** 建立或复用下游 Socket.IO 连接，完成 ACP initialize + session new/复用握手 */
  private async ensureConnection(
    sessionId: string,
    downstreamUrl: string,
    agent: AgentInstanceDto,
    options: {
      downstreamSessionId?: string | null;
      activeRunId?: string;
      activeOrchestratorAgentId?: AgentId;
      forceSessionNew?: boolean;
    } = {},
  ): Promise<ConnectionRecord> {
    if (options.forceSessionNew) {
      const existing = this.connections.get(sessionId);
      if (existing) { existing.closing = true; existing.acp.close(); this.connections.delete(sessionId); }
      options.downstreamSessionId = undefined;
    }
    const existing = this.connections.get(sessionId);
    if (existing?.socket.connected) {
      return existing;
    }

    if (existing) {
      existing.closing = true;
      existing.acp.close();
      this.connections.delete(sessionId);
    }

    const socket = io(downstreamUrl, {
      transports: ["websocket"],
      reconnection: false,
    });

    await waitForSocket(socket);

    const acp = new AcpConnection(socket, RECOVERY_TIMEOUT_MS);
    acp.onNotification((env) => void this.handleDownstreamEvent(sessionId, env));

    let resolveReady!: (id: string) => void;
    let rejectReady!: (error: Error) => void;
    const downstreamReady = new Promise<string>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const record: ConnectionRecord = {
      key: sessionId,
      socket,
      acp,
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
    };
    this.connections.set(sessionId, record);

    socket.on("disconnect", () => {
      this.logger.warn(`[连接] sessionId=${sessionId} 下游连接断开`);
      this.clearIdleTimer(record);
      record.needsBootstrap = true;
      if (this.connections.get(sessionId) === record) {
        this.connections.delete(sessionId);
      }
      if (record.activeRunId && !record.closing) {
        void this.failRun(
          sessionId,
          record.activeRunId,
          record.activeOrchestratorAgentId ?? 1,
          "DOWNSTREAM_DISCONNECTED",
          "downstream disconnected",
        );
      }
    });

    socket.on("connect_error", () => {
      this.logger.error(`[连接] sessionId=${sessionId} socket连接错误`);
    });

    // Legacy event channels for downstream compatibility
    socket.on("session/event", (event) => void this.handleDownstreamEvent(sessionId, event as DownstreamEnvelope));
    socket.on("acp:event", (event) => void this.handleDownstreamEvent(sessionId, event as DownstreamEnvelope));
    socket.on("message", (event) => void this.handleDownstreamEvent(sessionId, event as DownstreamEnvelope));

    const initParams = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } };
    try {
      this.logger.log(`[发送JSON] initialize: ${JSON.stringify({ jsonrpc: "2.0", id: "<acp-auto>", method: "initialize", params: initParams })}`);
      const initResult = await acp.request("initialize", initParams);
      this.logger.log(`[接收JSON] initialize响应: ${JSON.stringify({ jsonrpc: "2.0", id: "<response>", result: initResult })}`);

      if (record.downstreamSessionId) {
        this.logger.log(`[握手] 复用下游sessionId=${record.downstreamSessionId}`);
        record.resolveDownstreamReady?.(record.downstreamSessionId);
        this.markDownstreamActivity(record);
        this.scheduleIdleDisconnectCheck(record);
        return record;
      }

      const sessionParams = { _meta: { agentId: String(agent.id), agenthubSessionId: sessionId }, mcpServers: [] };
      this.logger.log(`[发送JSON] session/new: ${JSON.stringify({ jsonrpc: "2.0", id: "<acp-auto>", method: "session/new", params: sessionParams })}`);
      const result = await acp.request("session/new", sessionParams);
      const resultSessionId = stringValue(result.sessionId);
      if (!resultSessionId) throw new Error("DOWNSTREAM_SESSION_ID_MISSING");
      this.logger.log(`[接收JSON] session/new响应: ${JSON.stringify({ jsonrpc: "2.0", id: "<response>", result })}`);
      record.downstreamSessionId = resultSessionId;
      record.needsBootstrap = true;
      await this.refreshSandboxMapping(sessionId, resultSessionId, result);
      record.resolveDownstreamReady?.(resultSessionId);
    } catch (error) {
      this.logger.error(`[握手] 失败 ${error instanceof Error ? error.message : String(error)}`);
      record.rejectDownstreamReady?.(error instanceof Error ? error : new Error(String(error)));
    }

    this.markDownstreamActivity(record);
    this.scheduleIdleDisconnectCheck(record);
    return record;
  }

  /** 准备下游 session 并发送 prompt；旧 sessionId 失效时可回退 session/new。 */
  private async dispatchPrompt(
    input: StartRunInput,
    downstreamUrl: string,
    options: { forceSessionNew?: boolean; allowSessionNewFallback: boolean },
  ) {
    const sessionDownstreamId = options.forceSessionNew ? null : await this.readSessionDownstreamId(input.sessionId);
    this.logger.log(`[startRun] session下游ID=${sessionDownstreamId ?? "空"} → ${sessionDownstreamId ? "复用已有下游session" : "将创建新下游session"}`);

    const connection = await this.ensureConnection(input.sessionId, downstreamUrl, input.orchestrator, {
      downstreamSessionId: sessionDownstreamId,
      forceSessionNew: options.forceSessionNew,
    });
    const downstreamSessionId = await connection.downstreamReady;
    if (!downstreamSessionId) throw new Error("DOWNSTREAM_SESSION_NOT_FOUND");

    this.logger.log(`[startRun] 下游就绪 downstreamSessionId=${downstreamSessionId} 需bootstrap=${connection.needsBootstrap}`);
    if (downstreamSessionId !== sessionDownstreamId) {
      await this.persistSessionDownstreamId(input.sessionId, downstreamSessionId);
      this.logger.log(`[startRun] 下游sessionId已更新到sessions表: ${sessionDownstreamId ?? "空"} → ${downstreamSessionId}`);
    }

    const sessionActive = await this.getSessionActive(input.sessionId);
    const needsBootstrap = connection.needsBootstrap || !sessionActive;
    this.logger.log(`[startRun] sessionActive=${sessionActive} needsBootstrap=${needsBootstrap}`);
    const contextSnapshot = needsBootstrap ? await this.createBootstrapSnapshot(input) : null;
    const promptInput = await this.buildPromptInput(
      { ...input, context: contextSnapshot },
      downstreamSessionId,
      needsBootstrap,
    );

    connection.activeRunId = input.runId;
    connection.activeOrchestratorAgentId = input.orchestrator.id;
    const promptResponse = this.sendPromptRequest(connection, promptInput as Record<string, unknown>);
    connection.needsBootstrap = false;
    this.markDownstreamActivity(connection);
    await this.markPromptSent(input, downstreamSessionId);

    try {
      const result = await promptResponse;
      await this.handlePromptResult(connection, result);
    } catch (error) {
      if (isPromptResponseTimeout(error)) return;
      if (options.allowSessionNewFallback && sessionDownstreamId && isReusableSessionMissingError(error)) {
        this.logger.warn(`[startRun] 下游sessionId失效，回退session/new: ${sessionDownstreamId}`);
        await this.events.append({
          sessionId: input.sessionId,
          runId: input.runId,
          eventType: "run.status",
          speakerAgentId: input.orchestrator.id,
          source: "agenthub_backend",
          payload: { status: "connecting", reason: "downstream_session_invalid" },
        });
        await this.dispatchPrompt(input, downstreamUrl, { forceSessionNew: true, allowSessionNewFallback: false });
        return;
      }
      throw error;
    }
  }

  private sendPromptRequest(record: ConnectionRecord, promptInput: Record<string, unknown>) {
    const promptBrief = briefPromptInput(promptInput);
    this.logger.log(`[发送JSON] session/prompt: ${JSON.stringify({ jsonrpc: "2.0", id: "<acp-auto>", method: "session/prompt", params: promptBrief })}`);
    return record.acp.request("session/prompt", promptInput, PROMPT_RESPONSE_GRACE_MS);
  }

  private async markPromptSent(input: StartRunInput, downstreamSessionId: string) {
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
  }

  private async handlePromptResult(record: ConnectionRecord, result: Record<string, unknown>) {
    const stopReason = stringValue(result.stopReason);
    if (!stopReason) return;
    const runId = record.activeRunId;
    if (!runId) return;
    this.logger.log(`[result] stopReason=${stopReason} 完成run runId=${runId}`);
    await this.markRunCompleted(record.sessionId, runId);
  }

  /** 更新下游连接最近活跃时间并调度空闲检查 */
  private markDownstreamActivity(record: ConnectionRecord) {
    record.lastActivityAt = Date.now();
    void this.touchSessionActive(record.sessionId);
    this.scheduleIdleDisconnectCheck(record);
  }

  /** 下游执行不依赖文件面板映射，Redis 刷新失败时不阻断 run */
  private async refreshSandboxMapping(sessionId: string, downstreamSessionId: string, result: Record<string, unknown>) {
    try {
      await this.sandboxRegistry?.saveFromSessionResult(sessionId, downstreamSessionId, result);
    } catch {
      // 文件直连映射是可选能力，失败时保持下游执行链路可用。
    }
  }

  /** 调度空闲断开检查定时器（Redis TTL代替内存计时） */
  private scheduleIdleDisconnectCheck(record: ConnectionRecord) {
    this.clearIdleTimer(record);
    record.idleTimer = setTimeout(() => void this.closeIfIdle(record), IDLE_RECHECK_MS);
  }

  /** 空闲时断开连接：无活跃 run 且无 WebSocket 订阅者则断开 */
  private async closeIfIdle(record: ConnectionRecord) {
    if (this.connections.get(record.key) !== record) return;
    if (record.activeRunId) {
      this.clearIdleTimer(record);
      record.idleTimer = setTimeout(() => void this.closeIfIdle(record), IDLE_RECHECK_MS);
      return;
    }
    const active = await this.getSessionActive(record.sessionId);
    if (!active && !this.gateway.hasSessionSubscribers(record.sessionId)) {
      this.logger.log(`[空闲断连] sessionId=${record.sessionId} Redis已过期且无前端订阅，断开下游连接`);
      record.acp.close();
      this.connections.delete(record.key);
      return;
    }
    this.clearIdleTimer(record);
    record.idleTimer = setTimeout(() => void this.closeIfIdle(record), IDLE_RECHECK_MS);
  }

  /** 清除空闲断开定时器 */
  private clearIdleTimer(record: ConnectionRecord) {
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = null;
    }
  }

  // ---- Redis session activity tracking ----

  private sessionActivityKey(sessionId: string) {
    return `agenthub:session:active:${sessionId}`;
  }

  /** 刷新 session 活跃时间（发送prompt或收到下游事件时调用） */
  private async touchSessionActive(sessionId: string) {
    try {
      await this.redis.set(this.sessionActivityKey(sessionId), "1", "EX", IDLE_TIMEOUT_SECONDS);
    } catch {
      // Redis unavailable is non-fatal
    }
  }

  /** 检查 session 是否仍活跃（Redis key存在=活跃） */
  private async getSessionActive(sessionId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(this.sessionActivityKey(sessionId))) === 1;
    } catch {
      return true; // Redis down → assume active
    }
  }

  /**
   * 处理下游通知（session/update、session/event 及 legacy 事件）。
   * JSON-RPC 响应匹配已由 AcpConnection 内部处理，此处仅处理通知。
   */
  private async handleDownstreamEvent(sessionId: string, envelope: DownstreamEnvelope) {
    const record = this.connections.get(sessionId);
    if (!record) return;
    this.markDownstreamActivity(record);

    const envelopeId = typeof envelope.id === "number" || typeof envelope.id === "string" ? envelope.id : undefined;
    const params = asRecord(envelope.params ?? envelope.payload ?? envelope);
    this.logger.log(`[接收] sessionId=${sessionId} method=${envelope.method ?? "无"} type=${stringValue(params.type) ?? stringValue(params.eventType) ?? "无"} id=${envelopeId ?? "无"}`);
    this.logger.log(`[接收JSON] ${safeJson(envelope, 8000)}`);

    // Handle session/update (agent message chunks from downstream)
    if (envelope.method === "session/update") {
      try {
        const update = params.update;
        const content = asRecord(typeof update === "object" ? update : {});
        const meta = asRecord(params._meta ?? (content as any)._meta);
        const text = stringValue(content.text) ?? stringValue((content as any).content?.text);
        const sessionUpdate = stringValue((content as any).sessionUpdate);
        let runId = stringValue(meta.runId) ?? record.activeRunId;
        if (!runId) {
          // 从数据库查找该session最近的活跃run（running或已完成）
          const latestRun = await this.prisma.agentRun.findFirst({
            where: { sessionId: record.sessionId, status: { in: ["running", "context_building", "connecting", "completed"] } },
            orderBy: { createdAt: "desc" },
            select: { id: true, status: true },
          });
          if (latestRun) {
            runId = latestRun.id;
            record.activeRunId = runId;
            this.logger.log(`[session/update] 从数据库恢复runId=${runId} status=${latestRun.status}`);
          }
        }
        this.logger.log(`[session/update] runId=${runId} hasText=${!!text} sessionUpdate=${sessionUpdate ?? "无"}`);
        if (!runId) {
          this.logger.warn(`[session/update] 缺少runId，丢弃`);
          if (envelopeId !== undefined) record.acp.respondError(envelopeId, "RUN_ID_REQUIRED", "RUN_ID_REQUIRED");
          return;
        }
        if (text && runId) {
          const speaker = stringValue(meta.agentId) ?? "agent";
          const speakerAgentId = agentIdValue(meta.agentId);
          const isChunk = sessionUpdate === "agent_message_chunk";
          const isStop = sessionUpdate === "agent_message_stop" || sessionUpdate === "stop";
          // 每个chunk都发delta，前端增量渲染
          if (isChunk) {
            this.logger.log(`[session/update] chunk增量 runId=${runId} textLen=${text.length}`);
          }
          await this.events.append({
            sessionId: record.sessionId,
            runId,
            eventType: "message.delta",
            speakerAgentId,
            source: "downstream_agent",
            payload: { text, speaker, append: !isChunk },
          });
          if (isChunk || isStop) {
            this.logger.log(`[session/update] 消息完成 runId=${runId}`);
            await this.events.append({
              sessionId: record.sessionId,
              runId,
              eventType: "message.completed",
              speakerAgentId,
              source: "downstream_agent",
              payload: { text, speaker },
            });
            // 结束事件由downstream的stopReason result触发，不用自动完成
          }
        }
        if (envelopeId !== undefined) record.acp.respond(envelopeId);
      } catch (error) {
        if (envelopeId !== undefined) {
          const msg = error instanceof Error ? error.message : String(error);
          record.acp.respondError(envelopeId, errorCode(msg), msg);
        }
      }
      return;
    }

    if (envelope.error) {
      const message = downstreamErrorMessage(envelope.error);
      const code = downstreamErrorCode(envelope.error, message);
      this.logger.warn(`[result] 下游请求失败 code=${code} message=${message}`);
      if (record.activeRunId) {
        await this.failRun(record.sessionId, record.activeRunId, record.activeOrchestratorAgentId ?? 1, code, message);
      }
      return;
    }

    // Handle JSON-RPC result with stopReason (downstream task completion signal)
    if (envelope.result) {
      this.logger.log(`[result] 收到下游result ${JSON.stringify(envelope.result)}`);
      await this.handlePromptResult(record, asRecord(envelope.result));
      return;
    }

    // Handle structured session/event reports from downstream agents.
    if (envelope.method && envelope.method !== "session/event") {
      this.logger.warn(`[接收] 未知method=${envelope.method}，丢弃`);
      return;
    }
    const meta = asRecord(params._meta);
    this.logger.log(`[session/event] params有runId=${!!params.runId} envelope有runId=${!!envelope.runId} activeRunId=${record.activeRunId}`);
    const runId = stringValue(meta.runId) ?? stringValue(params.runId) ?? stringValue(envelope.runId) ?? record.activeRunId;
    if (!runId) {
      this.logger.warn(`[session/event] 缺少runId，丢弃`);
      if (envelopeId !== undefined) record.acp.respondError(envelopeId, "RUN_ID_REQUIRED", "RUN_ID_REQUIRED");
      return;
    }

    // Drop events for runs that have been cancelled
    if (await this.isRunCancelled(runId)) {
      if (envelopeId !== undefined) record.acp.respondError(envelopeId, "RUN_ALREADY_CANCELLED", "RUN_ALREADY_CANCELLED");
      return;
    }

    const eventType = stringValue(params.type) ?? stringValue(params.eventType);
    if (!eventType) {
      if (envelopeId !== undefined) record.acp.respondError(envelopeId, "EVENT_TYPE_REQUIRED", "EVENT_TYPE_REQUIRED");
      return;
    }
    const payload = asRecord(params.payload ?? params);

    const speakerAgentId =
      agentIdValue(meta.agentId) ??
      agentIdValue(params.speaker) ??
      agentIdValue(payload.speaker) ??
      agentIdValue(envelope.speaker);

    try {
      this.logger.log(`[session/event] 持久化 eventType=${eventType} runId=${runId} speaker=${speakerAgentId}`);
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
        this.logger.log(`[session/event] run完成 runId=${runId}`);
        await this.markRunCompleted(record.sessionId, runId);
      }
      if (eventType === "run.failed") {
        this.logger.log(`[session/event] run失败 runId=${runId}`);
        await this.markRunFailed(
          record.sessionId,
          runId,
          "DOWNSTREAM_RUN_FAILED",
          stringValue(payload.message) ?? "run failed",
        );
      }
      if (envelopeId !== undefined) record.acp.respond(envelopeId);
    } catch (error) {
      this.logger.error(`[session/event] 持久化失败 ${error instanceof Error ? error.message : String(error)}`);
      if (envelopeId !== undefined) {
        const msg = error instanceof Error ? error.message : String(error);
        record.acp.respondError(envelopeId, errorCode(msg), msg);
      }
    }
  }

  /** Mock 模式模拟运行：未配置下游时生成示例事件 */
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

  /** 读取 Session 表的下游 session ID */
  private async readSessionDownstreamId(sessionId: string): Promise<string | null> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { downstreamSessionId: true },
    });
    return session?.downstreamSessionId ?? null;
  }

  /** 将下游 session ID 持久化到 Session 表 */
  private async persistSessionDownstreamId(sessionId: string, downstreamSessionId: string) {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { downstreamSessionId },
    });
  }

  /** 检查 run 是否已被取消 */
  private async isRunCancelled(runId: string): Promise<boolean> {
    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    return run?.status === "cancelled";
  }

  /** 为新会话创建引导上下文快照 */
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

  /** 标记 run 完成并推送会话更新 */
  private async markRunCompleted(sessionId: string, runId: string) {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date() },
    });
    const session = await this.prisma.session.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    this.gateway.emitSession(mapSession(session));
  }

  /** 标记 run 失败并推送会话更新 */
  private async markRunFailed(sessionId: string, runId: string, code: string, message: string) {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: { status: "failed", errorCode: code, errorMessage: message, completedAt: new Date() },
    });
    if (typeof this.prisma.session.findUnique === "function") {
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      if (session) this.gateway.emitSession(mapSession(session));
    }
  }

  /** 构建 ACP session/prompt 的输入参数 */
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
    const promptMode = bootstrap ? "bootstrap" : "incremental";
    const agents = bootstrap ? await this.loadSessionAgentBriefs(input.sessionId, input.orchestrator.id) : [];
    const promptText = renderAgentGatewayPrompt({
      promptText: input.promptText,
      promptMode,
      contextText: bootstrap ? input.context?.promptText : undefined,
      messageContext: input.messageContext,
      mentionedAgents: input.mentionedAgents,
      agents,
    });

    return {
      sessionId: downstreamSessionId,
      prompt: [{ type: "text", text: promptText }],
      _meta: {
        source: "agenthub",
        agentId: String(input.orchestrator.id),
        agenthubSessionId: input.sessionId,
        runId: input.runId,
        messageId: input.userMessageId,
        orchestratorAgentId: String(input.orchestrator.id),
        mentionedAgentIds: input.mentionedAgents.map((agent) => String(agent.id)),
        contextSnapshotId: input.context?.id ?? null,
      },
    };
  }

  /** 加载会话成员 Agent 简要描述（排除 orchestrator） */
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

  /** 完结 run：更新状态，推送事件和会话 */
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

  /** 标记 run 为失败：更新状态，推送失败事件和会话 */
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

function renderAgentGatewayPrompt(input: {
  promptText: string;
  promptMode: "bootstrap" | "incremental";
  contextText?: string;
  messageContext?: Record<string, unknown>;
  mentionedAgents: AgentInstanceDto[];
  agents: Array<{ agentId: AgentId; description: string }>;
}) {
  const sections = [
    `# AgentHub Request (${input.promptMode})`,
    input.contextText ? `## Session Context\n${input.contextText}` : "",
    input.mentionedAgents.length > 0
      ? `## Mentioned Agents\n${input.mentionedAgents.map((agent) => `- ${agent.name} (${agent.id})`).join("\n")}`
      : "",
    input.agents.length > 0
      ? `## Available Worker Agents\n${input.agents.map((agent) => `- ${agent.agentId}: ${agent.description}`).join("\n")}`
      : "",
    messageContextPrompt(input.messageContext),
    `## Current User Request\n${input.promptText}`,
  ];
  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}

function messageContextPrompt(context?: Record<string, unknown>) {
  if (!context || Object.keys(context).length === 0) return "";
  const text = safeJson(context, 12000);
  return text ? `## Current Message Context\n${text}` : "";
}

function safeJson(value: unknown, maxLength: number) {
  try {
    const rendered = JSON.stringify(value, jsonReplacer, 2);
    return rendered.length > maxLength ? `${rendered.slice(0, maxLength)}\n...[truncated]` : rendered;
  } catch {
    return "";
  }
}

function jsonReplacer(_key: string, value: unknown) {
  if (typeof value === "string" && value.length > 4000) return `${value.slice(0, 4000)}...[truncated]`;
  return value;
}

function downstreamFeatureEnabled(name: string) {
  const value = process.env[name];
  return value === "1" || value === "true" || value === "yes";
}

function agentIdValue(value: unknown): AgentId | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function errorCode(message: string) {
  return /^[A-Z0-9_]+$/.test(message) ? message : "DOWNSTREAM_EVENT_FAILED";
}

function briefPromptInput(promptInput: Record<string, unknown>) {
  const prompt = Array.isArray(promptInput.prompt)
    ? promptInput.prompt.map((part) => {
      const record = asRecord(part);
      const text = stringValue(record.text);
      return text ? { ...record, text: `${text.slice(0, 200)}${text.length > 200 ? `...[${text.length}字符]` : ""}` } : record;
    })
    : promptInput.prompt;
  return { ...promptInput, prompt };
}

function isPromptResponseTimeout(error: unknown) {
  return error instanceof Error && error.message === "SESSION/PROMPT_TIMEOUT";
}

function isReusableSessionMissingError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.message === "SESSION_NOT_FOUND" || error.message === "DOWNSTREAM_SESSION_NOT_FOUND";
}

function downstreamErrorMessage(error: NonNullable<DownstreamEnvelope["error"]>) {
  return typeof error === "string" ? error : error.message ?? "DOWNSTREAM_REQUEST_FAILED";
}

function downstreamErrorCode(error: NonNullable<DownstreamEnvelope["error"]>, message: string) {
  if (typeof error !== "string" && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code)) return error.code;
  return errorCode(message);
}
