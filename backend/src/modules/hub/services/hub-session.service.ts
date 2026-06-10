import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  AddParticipantRequest,
  AgentInstanceDto,
  CreatePendingHubMessageRequest,
  CreateHubSessionRequest,
  HubMessagePartDto,
  ListSessionsResponse,
  PinHubMessageRequest,
  SendHubMessageRequest,
  SendHubMessageResponse,
  SessionDetailDto,
  SessionDiffContextDto,
  SessionTimelinePageDto,
  UpdatePendingHubMessageRequest,
  UpdateHubSessionRequest,
} from "@agenthub/shared";
import { AgentRegistryService } from "./agent-registry.service";
import { HubContextService, messagePartContextText } from "./context.service";
import { DownstreamOrchestratorService } from "./downstream-orchestrator.service";
import { HubEventService } from "./event.service";
import { DeploymentService } from "./deployment.service";
import {
  mapArtifact,
  mapEvent,
  mapFileChange,
  mapMessage,
  mapRun,
  mapSession,
} from "../mappers/hub.mappers";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { PrismaService } from "./prisma.service";
import { PendingMessageQueueService } from "./pending-message-queue.service";
import { buildLinkPreviewParts, messageJsonWithParts } from "../utils/message-parts";

/** 会话服务：管理会话 CRUD、消息收发、@提及、附件、上下文引用和运行编排 */
@Injectable()
export class HubSessionService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(AgentRegistryService)
    private readonly agents: AgentRegistryService,
    @Inject(HubContextService)
    private readonly context: HubContextService,
    @Inject(DownstreamOrchestratorService)
    private readonly downstream: DownstreamOrchestratorService,
    @Inject(HubEventService)
    private readonly events: HubEventService,
    @Inject(DeploymentService)
    private readonly deployments: DeploymentService,
    @Inject(HubRealtimeGateway)
    private readonly gateway: HubRealtimeGateway,
    @Inject(PendingMessageQueueService)
    private readonly pendingMessages: PendingMessageQueueService,
  ) {
    this.events.onRunTerminal((sessionId) => {
      void this.drainPendingMessages(sessionId);
    });
  }

  /** 列出会话，支持搜索和归档过滤，置顶优先排序 */
  async listSessions(input: { query?: string; includeArchived?: boolean; limit?: number; cursor?: string } = {}): Promise<ListSessionsResponse> {
    const query = input.query?.trim().toLowerCase() ?? "";
    const limit = normalizeLimit(input.limit, 10, 50);
    const cursor = decodeSessionCursor(input.cursor);
    const statusWhere = input.includeArchived
      ? Prisma.sql`s.status <> 'deleted'::session_status`
      : Prisma.sql`s.status = 'active'::session_status`;
    const queryWhere = query
      ? Prisma.sql`AND (
          lower(s.title) LIKE ${`%${query}%`}
          OR EXISTS (
            SELECT 1
            FROM "session_agents" sa
            JOIN "agents" a ON a.id = sa.agent_id
            WHERE sa.session_id = s.id
              AND sa.participant_role <> 'deleted'
              AND lower(a.name) LIKE ${`%${query}%`}
          )
        )`
      : Prisma.empty;
    const cursorWhere = cursor
      ? Prisma.sql`AND (
          CASE WHEN s.metadata->>'isPinned' = 'true' THEN 1 ELSE 0 END < ${cursor.pinned ? 1 : 0}
          OR (
            CASE WHEN s.metadata->>'isPinned' = 'true' THEN 1 ELSE 0 END = ${cursor.pinned ? 1 : 0}
            AND (
              s.updated_at < ${cursor.updatedAt}::timestamptz
              OR (s.updated_at = ${cursor.updatedAt}::timestamptz AND s.id < ${cursor.id}::uuid)
            )
          )
        )`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; updatedAt: Date; isPinned: boolean }>>`
      SELECT
        s.id::text AS id,
        s.updated_at AS "updatedAt",
        (s.metadata->>'isPinned' = 'true') AS "isPinned"
      FROM "sessions" s
      WHERE ${statusWhere}
      ${queryWhere}
      ${cursorWhere}
      ORDER BY
        CASE WHEN s.metadata->>'isPinned' = 'true' THEN 1 ELSE 0 END DESC,
        s.updated_at DESC,
        s.id DESC
      LIMIT ${limit + 1}
    `;
    const pageRows = rows.slice(0, limit);
    const sessions = pageRows.length
      ? await this.prisma.session.findMany({
          where: { id: { in: pageRows.map((row) => row.id) } },
          include: {
            runs: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        })
      : [];
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const ordered = pageRows.flatMap((row) => {
      const session = byId.get(row.id);
      return session ? [session] : [];
    });
    const last = pageRows.at(-1);
    return {
      items: ordered.map(mapSession),
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit && last ? encodeSessionCursor(last) : null,
    };
  }

  /** 创建会话：支持 direct 单聊和 group 群聊模式，自动创建对应的 Agent */
  async createSession(input: CreateHubSessionRequest) {
    const mode = input.mode === "direct" || input.directTemplateId ? "direct" : "group";
    if (mode === "direct" && !input.directTemplateId) throw new BadRequestException("DIRECT_TEMPLATE_REQUIRED");
    if (mode === "group" && !input.orchestratorTemplateId) throw new BadRequestException("ORCHESTRATOR_TEMPLATE_REQUIRED");
    const session = await this.prisma.session.create({
      data: {
        title: input.title?.trim() || (mode === "direct" ? "新单聊" : "新 Agent 群聊"),
        metadata: {
          ...(input.metadata ?? {}),
          isPinned: Boolean(input.metadata?.isPinned),
          mode,
          titleSource: input.title?.trim() ? "manual" : "auto",
        } as any,
      },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });

    let directAgentId: number | null = null;
    let orchestratorAgentId: number | null = null;
    const memberAgentIds: number[] = [];

    if (mode === "direct") {
      const agent = await this.agents.createAgentFromTemplate(
        session.id,
        input.directTemplateId!,
        input.directProvider,
        input.directName,
        "direct",
      );
      directAgentId = agent.id;
    }

    if (mode === "group" && input.orchestratorTemplateId) {
      const agent = await this.agents.createAgentFromTemplate(
        session.id,
        input.orchestratorTemplateId,
        input.orchestratorProvider,
        input.orchestratorName,
        "orchestrator",
      );
      orchestratorAgentId = agent.id;
    }

    if (mode === "group" && input.memberTemplates?.length) {
      for (const mt of input.memberTemplates) {
        const agent = await this.agents.createAgentFromTemplate(session.id, mt.templateId, mt.provider, mt.name, "member");
        memberAgentIds.push(agent.id);
      }
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        metadata: mergeMetadata(session.metadata, {
          mode,
          directAgentId,
          orchestratorAgentId,
          memberAgentIds,
        }) as any,
      },
    });

    // Reload session with updated participants
    const updated = await this.prisma.session.findUnique({
      where: { id: session.id },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const dto = mapSession(updated!);
    this.gateway.emitSession(dto);
    void this.downstream.prepareSessionConnection(session.id);
    return dto;
  }

  /** 获取会话首屏详情：只返回最近消息及其 run/event，重数据按需加载 */
  async getDetail(sessionId: string, input: { messageLimit?: number } = {}): Promise<SessionDetailDto> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!session || session.status === "deleted") {
      throw new NotFoundException("SESSION_NOT_FOUND");
    }
    const timelinePage = await this.listTimeline(sessionId, { limit: input.messageLimit, skipSessionCheck: true });

    return {
      session: mapSession(session),
      messages: timelinePage.messages,
      runs: timelinePage.runs,
      events: timelinePage.events,
      artifacts: [],
      fileChanges: [],
      context: null,
      timelinePage: { hasMore: timelinePage.hasMore, nextCursor: timelinePage.nextCursor },
    };
  }

  /** 按消息时间向前分页加载会话时间线 */
  async listTimeline(
    sessionId: string,
    input: { limit?: number; before?: string; skipSessionCheck?: boolean; includeOutputs?: boolean } = {},
  ): Promise<SessionTimelinePageDto> {
    if (!input.skipSessionCheck) {
      const session = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } });
      if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    }
    const limit = normalizeLimit(input.limit, 10, 50);
    const before = decodeMessageCursor(input.before);
    const messageWhere = before
      ? {
          sessionId,
          OR: [
            { createdAt: { lt: before.createdAt } },
            { createdAt: before.createdAt, id: { lt: before.id } },
          ],
        }
      : { sessionId };
    const messagesDesc = await this.prisma.message.findMany({
      where: messageWhere,
      include: { agent: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const pageMessagesDesc = messagesDesc.slice(0, limit);
    const messages = [...pageMessagesDesc].reverse();
    const messageIds = messages.map((message) => message.id);
    const directRunIds = messages
      .map((message) => message.runId)
      .filter((runId): runId is string => Boolean(runId));
    const runs = messageIds.length || directRunIds.length
      ? await this.prisma.agentRun.findMany({
          where: {
            sessionId,
            OR: [
              { id: { in: directRunIds } },
              { userMessageId: { in: messageIds } },
              { assistantMessageId: { in: messageIds } },
            ],
          },
          orderBy: { createdAt: "asc" },
        })
      : [];
    const runIds = runs.map((run) => run.id);
    const events = runIds.length
      ? await this.prisma.agentEvent.findMany({
          where: { sessionId, runId: { in: runIds } },
          orderBy: [{ persistedAt: "asc" }, { seq: "asc" }],
        })
      : [];
    const [artifacts, fileChanges] = runIds.length && input.includeOutputs
      ? await Promise.all([
          this.prisma.artifact.findMany({
            where: { sessionId, runId: { in: runIds } },
            orderBy: { updatedAt: "desc" },
          }),
          this.prisma.fileChange.findMany({
            where: { sessionId, runId: { in: runIds } },
            orderBy: { createdAt: "desc" },
          }),
        ])
      : [[], []] as const;
    const oldest = pageMessagesDesc.at(-1);
    return {
      messages: messages.map(mapMessage),
      runs: runs.map(mapRun),
      events: events.map(mapEvent),
      artifacts: artifacts.map(mapArtifact),
      fileChanges: fileChanges.map(mapFileChange),
      hasMore: messagesDesc.length > limit,
      nextCursor: messagesDesc.length > limit && oldest ? encodeMessageCursor(oldest) : null,
    };
  }

  async listPinnedMessages(sessionId: string, input: { limit?: number } = {}) {
    const limit = normalizeLimit(input.limit, 20, 50);
    const messages = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT m.* FROM messages m WHERE m.session_id = $1::uuid AND (m.is_pinned = true OR (m.content_json->>'pinnedPartIds')::jsonb <> '[]'::jsonb) ORDER BY m.updated_at DESC LIMIT $2`,
      sessionId,
      limit,
    );
    const agents = await this.prisma.agent.findMany({
      where: { id: { in: messages.filter((m) => m.agent_id != null).map((m) => m.agent_id as number) } },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    return { items: messages.map((row: any) => mapMessage({ ...row, agent: row.agent_id ? agentMap.get(row.agent_id) ?? null : null })) };
  }

  /** 获取会话 Diff 审查范围说明 */
  async getDiffContext(sessionId: string): Promise<SessionDiffContextDto> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: true },
    });
    if (!session || session.status === "deleted") {
      throw new NotFoundException("SESSION_NOT_FOUND");
    }

    const baseRef = session.project?.defaultBranch?.trim() || "main";
    return {
      baseRef,
      targetRef: "working tree",
      projectName: session.project?.name ?? null,
      githubUrl: session.project?.githubUrl ?? null,
      defaultBranch: session.project?.defaultBranch ?? null,
      explanation: session.project
        ? "右侧 Diff 对比的是绑定项目默认分支与本次 Agent 生成的工作区改动；这里用于说明审查范围，不会切换 Git 分支。"
        : "当前会话未绑定项目，Diff 暂以 main 作为展示基准；绑定项目后会使用项目默认分支说明审查范围。",
      canChangeBase: false,
    };
  }

  /** 添加已有 Agent 作为会话参与者，通知下游 */
  async addParticipant(sessionId: string, input: AddParticipantRequest) {
    const currentSession = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { status: true, metadata: true },
    });
    if (!currentSession || currentSession.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    if (currentSession.status !== "active") throw new BadRequestException("SESSION_NOT_ACTIVE");
    await this.assertNoActiveRun(sessionId);

    const agent = await this.agents.getAgent(input.agentId);
    if (!agent) throw new Error("Agent not found");

    await this.prisma.sessionAgent.upsert({
      where: { sessionId_agentId: { sessionId, agentId: input.agentId } },
      create: {
        sessionId,
        agentId: input.agentId,
        participantRole: "member",
        source: "manual_add",
        firstMentionedAt: new Date(),
        lastActiveAt: new Date(),
      },
      update: {
        source: "manual_add",
        lastActiveAt: new Date(),
      },
    });

    const metadata = mergeMetadata(currentSession.metadata, {});
    const memberAgentIds = Array.isArray(metadata.memberAgentIds)
      ? metadata.memberAgentIds.filter((item): item is number => typeof item === "number")
      : [];
    if (!memberAgentIds.includes(input.agentId)) memberAgentIds.push(input.agentId);

    const session = await this.prisma.session.update({
      where: { id: sessionId },
      data: { updatedAt: new Date(), metadata: mergeMetadata(metadata, { memberAgentIds }) as any },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });

    const sessionDto = mapSession(session);
    this.gateway.emitSession(sessionDto);

    const runId = await this.findLatestRunId(sessionId);
    if (runId) {
      await this.events.append({
        sessionId,
        runId,
        eventType: "context.updated",
        source: "agenthub_backend",
        payload: { action: "participant_added", agentId: input.agentId, agentName: agent.name },
      });
    }
    this.downstream.notifyMemberAdded(sessionId, {
      agentId: input.agentId,
      description: agent.description || agent.template?.description || "",
    });

    return { session: sessionDto, agent };
  }

  /** 更新会话标题和置顶状态 */
  async updateSession(sessionId: string, input: UpdateHubSessionRequest) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");

    const data: Record<string, unknown> = { updatedAt: new Date() };
    const metadataPatch: Record<string, unknown> = {};

    if (typeof input.title === "string") {
      const title = input.title.trim();
      if (!title) throw new BadRequestException("TITLE_REQUIRED");
      data.title = title;
      metadataPatch.titleSource = "manual";
    }
    if (typeof input.isPinned === "boolean") {
      metadataPatch.isPinned = input.isPinned;
    }
    if (Object.keys(metadataPatch).length > 0) {
      data.metadata = mergeMetadata(session.metadata, metadataPatch);
    }

    const updated = await this.prisma.session.update({
      where: { id: sessionId },
      data: data as any,
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const dto = mapSession(updated);
    this.gateway.emitSession(dto);
    return dto;
  }

  /** 归档会话：关闭下游连接，标记为 archived */
  async archiveSession(sessionId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    await this.assertNoActiveRun(sessionId);

    const updated = await this.prisma.session.update({
      where: { id: sessionId },
      data: { status: "archived", updatedAt: new Date() },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    await this.downstream.closeSession(sessionId);
    const dto = mapSession(updated);
    this.gateway.emitSession(dto);
    return dto;
  }

  /** 软删除会话：关闭下游，标记状态为 deleted */
  async deleteSession(sessionId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    await this.assertNoActiveRun(sessionId);

    const updated = await this.prisma.session.update({
      where: { id: sessionId },
      data: { status: "deleted", updatedAt: new Date() },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    await this.downstream.closeSession(sessionId);
    const dto = mapSession(updated);
    this.gateway.emitSession(dto);
    return dto;
  }

  /** 发送消息主入口：解析 orchestrator/单聊 agent、@提及、附件、链接预览、引用，创建 run 并委托下游执行 */
  async sendMessage(sessionId: string, input: SendHubMessageRequest): Promise<SendHubMessageResponse> {
    const text = input.content.trim();
    if (!text) throw new Error("Message content is required");
    if ((input.attachments?.length ?? 0) > 5) throw new BadRequestException("TOO_MANY_ATTACHMENTS");
    const references = normalizeReferences(input);
    if (references.length > 5) throw new BadRequestException("TOO_MANY_REFERENCES");

    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    if (session.status !== "active") throw new BadRequestException("SESSION_NOT_ACTIVE");
    await this.assertNoActiveRun(sessionId);

    const metadata = mergeMetadata(session.metadata, {});
    const deploymentCommand = parseDeploymentCommand(text);
    const directAgentId = numberMetadataValue(metadata.directAgentId);
    const isDirect = metadata.mode === "direct" || Boolean(directAgentId);
    const runAgent = isDirect
      ? await this.agents.getAgent(directAgentId ?? 0)
      : await this.resolveSessionOrchestrator(metadata, input.orchestratorAgentId);
    if (!runAgent) throw new Error(isDirect ? "Direct agent not found" : "Orchestrator agent not found");

    const mentionedAgents = isDirect
      ? []
      : await this.resolveMentions(sessionId, text, input.mentionedAgentIds ?? []);
    const attachmentParts = await this.loadAttachmentParts(sessionId, input.attachments?.map((item) => item.id) ?? []);
    const linkParts = await buildLinkPreviewParts(text);
    const referenceBlocks = await this.loadReferenceBlocks(sessionId, references);
    const contextText = withReferencePrompt(withAttachmentPrompt(text, [...attachmentParts, ...linkParts]), referenceBlocks);
    const message = await this.prisma.message.create({
      data: {
        sessionId,
        role: "user",
        parentMessageId: input.parentMessageId ?? references[0]?.messageId,
        contentText: text,
        contentJson: messageJsonWithParts(
          {
            mentionedAgentIds: mentionedAgents.map((agent) => agent.id),
            attachmentIds: attachmentParts.map((part) => part.metadata?.artifactId),
            quotedMessageId: input.quotedMessageId ?? firstReferenceMessageId(references),
            quotedMessageIds: references.map((item) => item.messageId).filter((id): id is string => Boolean(id)),
            references,
          },
          text,
          [...attachmentParts, ...linkParts],
        ) as any,
        tokenCount: this.context.estimateTokens(contextText),
      },
    });

    await this.context.recordContextItem({
      sessionId,
      sourceType: "message",
      sourceId: message.id,
      kind: "message",
      text: contextText,
      importance: 20,
    });
    this.gateway.emitMessage(mapMessage(message));

    const run = await this.prisma.agentRun.create({
      data: {
        sessionId,
        orchestratorAgentId: runAgent.id,
        userMessageId: message.id,
        status: "queued",
      },
    });

    if (!isDirect) {
      await this.upsertSessionAgent(sessionId, runAgent.id, "orchestrator", "default_orchestrator");
      for (const agent of mentionedAgents) {
        await this.upsertSessionAgent(sessionId, agent.id, "member", "mention");
      }
    }

    const updatedSession = await this.prisma.session.update({
      where: { id: sessionId },
      data: { title: deriveTitle(session.title, text, session.metadata), updatedAt: new Date() },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });

    const sessionDto = mapSession(updatedSession);
    this.gateway.emitSession(sessionDto);
    await this.events.append({
      sessionId,
      runId: run.id,
      eventType: "run.created",
      speakerAgentId: runAgent.id,
      source: "agenthub_backend",
      payload: {
        status: "queued",
        command: deploymentCommand ? "deployment" : undefined,
        orchestratorAgentId: runAgent.id,
        mode: isDirect ? "direct" : "group",
        mentionedAgentIds: mentionedAgents.map((agent) => agent.id),
        mentionedAgentNames: mentionedAgents.map((agent) => agent.name),
      },
    });

    if (deploymentCommand) {
      let deploymentResult: Awaited<ReturnType<DeploymentService["start"]>>;
      try {
        deploymentResult = await this.deployments.start(sessionId, {});
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        await this.prisma.agentRun.update({
          where: { id: run.id },
          data: {
            status: "failed",
            errorCode: "DEPLOYMENT_TRIGGER_FAILED",
            errorMessage: messageText,
            completedAt: new Date(),
          },
        });
        await this.events.append({
          sessionId,
          runId: run.id,
          eventType: "run.failed",
          speakerAgentId: runAgent.id,
          source: "agenthub_backend",
          payload: {
            status: "failed",
            command: "deployment",
            message: messageText,
          },
        });
        throw error;
      }
      const completedRun = await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "completed", completedAt: new Date() },
      });
      await this.events.append({
        sessionId,
        runId: run.id,
        eventType: "run.completed",
        speakerAgentId: runAgent.id,
        source: "agenthub_backend",
        payload: {
          status: "completed",
          command: "deployment",
        },
      });
      return {
        session: sessionDto,
        message: mapMessage(message),
        messages: [mapMessage(message), deploymentResult.message],
        run: mapRun(completedRun),
        contextSnapshot: null,
      };
    }

    void this.downstream.startRun({
      sessionId,
      runId: run.id,
      userMessageId: message.id,
      promptText: text,
      messageContext: {
        attachments: attachmentParts,
        linkPreviews: linkParts,
        references: referenceBlocks,
      },
      orchestrator: runAgent,
      mentionedAgents,
    });

    return {
      session: sessionDto,
      message: mapMessage(message),
      run: mapRun(run),
      contextSnapshot: null,
    };
  }

  /** 列出 run 中待发送消息 */
  async listPendingMessages(sessionId: string) {
    await this.assertSessionActive(sessionId);
    if (!(await this.hasActiveRun(sessionId))) await this.drainPendingMessages(sessionId);
    return { items: await this.pendingMessages.list(sessionId) };
  }

  /** 添加待发送消息，不触发当前 run 的 steer/update */
  async createPendingMessage(sessionId: string, input: CreatePendingHubMessageRequest) {
    await this.assertSessionActive(sessionId);
    const pending = await this.pendingMessages.create(sessionId, input);
    if (!(await this.hasActiveRun(sessionId))) void this.drainPendingMessages(sessionId);
    return pending;
  }

  /** 修改待发送消息 */
  async updatePendingMessage(sessionId: string, pendingId: string, input: UpdatePendingHubMessageRequest) {
    await this.assertSessionActive(sessionId);
    return this.pendingMessages.update(sessionId, pendingId, input);
  }

  /** 删除待发送消息 */
  async deletePendingMessage(sessionId: string, pendingId: string) {
    await this.assertSessionActive(sessionId);
    return this.pendingMessages.delete(sessionId, pendingId);
  }

  /** run 终态后按 FIFO 派发下一条待发送消息 */
  async drainPendingMessages(sessionId: string) {
    if (await this.hasActiveRun(sessionId)) return;
    const pending = await this.pendingMessages.peek(sessionId);
    if (!pending || pending.status === "sending" || pending.status === "failed") return;

    await this.pendingMessages.markSending(sessionId, pending.id);
    try {
      await this.sendMessage(sessionId, pending.payload);
      await this.pendingMessages.markDrained(sessionId, pending.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.pendingMessages.markFailed(sessionId, pending.id, message);
    }
  }

  /** 置顶/取消置顶消息或消息部件 */
  async pinMessage(sessionId: string, messageId: string, input: PinHubMessageRequest) {
    const message = input.partId
      ? await this.context.setMessagePartPinned(sessionId, messageId, input.partId, input.pinned)
      : await this.context.setMessagePinned(sessionId, messageId, input.pinned);
    const mapped = mapMessage(message);
    const runId = message.runId ?? (await this.findLatestRunId(sessionId));
    if (runId) {
      await this.events.append({
        sessionId,
        runId,
        eventType: "context.updated",
        source: "agenthub_backend",
        payload: { messageId, partId: input.partId, pinned: input.pinned },
      });
    }
    this.downstream.notifyPinUpdated(sessionId, { messageId, partId: input.partId, pinned: input.pinned });
    return mapped;
  }

  /** 取消正在运行的 run */
  async cancelRun(sessionId: string, runId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error("Run not found");
    await this.downstream.cancelRun(sessionId, runId, run.orchestratorAgentId);
    return { runId, status: "cancelled" };
  }

  /** 重新发送用户消息以重新生成回复 */
  async regenerateFromMessage(sessionId: string, messageId: string) {
    const message = await this.resolveRegenerationSourceMessage(sessionId, messageId);
    const contentJson = mergeMetadata(message.contentJson, {});
    const attachmentIds = Array.isArray(contentJson.attachmentIds)
      ? contentJson.attachmentIds.filter((item): item is string => typeof item === "string")
      : [];
    const references = Array.isArray(contentJson.references)
      ? contentJson.references
          .map((item) => mergeMetadata(item, {}))
          .map((item) => ({
            messageId: typeof item.messageId === "string" ? item.messageId : undefined,
            partId: typeof item.partId === "string" ? item.partId : undefined,
            selectedText: cleanSelectedText(item.selectedText),
            sourceLabel: typeof item.sourceLabel === "string" ? item.sourceLabel.trim().slice(0, 80) : undefined,
          }))
          .filter((item) => item.messageId || item.selectedText)
      : undefined;
    return this.sendMessage(sessionId, {
      content: message.contentText,
      parentMessageId: message.parentMessageId ?? undefined,
      quotedMessageId: typeof contentJson.quotedMessageId === "string" ? contentJson.quotedMessageId : undefined,
      references,
      attachments: attachmentIds.map((id) => ({ id })),
    });
  }

  /** 解析重新生成时关联的用户消息 */
  private async resolveRegenerationSourceMessage(sessionId: string, messageId: string) {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, sessionId },
    });
    if (!message) throw new NotFoundException("MESSAGE_NOT_FOUND");
    if (message.role === "user") return message;
    if (message.runId) {
      const run = await this.prisma.agentRun.findUnique({
        where: { id: message.runId },
        select: { userMessageId: true },
      });
      if (run?.userMessageId) {
        const userMessage = await this.prisma.message.findFirst({
          where: { id: run.userMessageId, sessionId, role: "user" },
        });
        if (userMessage) return userMessage;
      }
    }
    throw new NotFoundException("USER_MESSAGE_NOT_FOUND");
  }

  /** 应用文件变更：通过下游连接发送 file/apply_diff */
  async applyFileChange(sessionId: string, fileChangeId: string) {
    await this.assertSessionActive(sessionId);
    await this.assertNoActiveRun(sessionId);
    const change = await this.prisma.fileChange.findFirst({
      where: { id: fileChangeId, sessionId },
    });
    if (!change) throw new NotFoundException("FILE_CHANGE_NOT_FOUND");

    await this.downstream.applyFileChanges({
      sessionId,
      runId: change.runId,
      fileChangeIds: [change.id],
      changes: [
        {
          id: change.id,
          path: change.path,
          patch: change.patch,
          beforeContent: change.beforeContent,
          afterContent: change.afterContent,
        },
      ],
    });
    await this.events.append({
      sessionId,
      runId: change.runId,
      eventType: "diff.apply.requested",
      source: "agenthub_backend",
      payload: { status: "queued", fileChangeIds: [change.id] },
    });
    return { ok: true, runId: change.runId, fileChangeIds: [change.id], status: "queued" as const };
  }

  /** 解析会话的 orchestrator agent */
  private async resolveSessionOrchestrator(metadata: Record<string, unknown>, requestedAgentId?: number) {
    const orchestratorAgentId = numberMetadataValue(metadata.orchestratorAgentId) ?? requestedAgentId;
    if (orchestratorAgentId) return this.agents.getAgent(orchestratorAgentId);
    return this.agents.getDefaultOrchestrator();
  }

  /** 从消息文本中解析 @提及 的 agent，如果未提及则返回全部成员 */
  private async resolveMentions(sessionId: string, text: string, explicitIds: number[]) {
    const agents = await this.loadSessionMemberAgents(sessionId);
    const ids = new Set(explicitIds);

    const lowerText = text.toLowerCase();
    for (const agent of agents) {
      const labels = [`@${agent.name}`, `@${agent.id}`].map((label) => label.toLowerCase());
      if (labels.some((label) => lowerText.includes(label))) {
        ids.add(agent.id);
      }
    }

    if (ids.size === 0) {
      return agents;
    }

    const mentioned = agents.filter((agent) => ids.has(agent.id));
    if (mentioned.length > 0) return mentioned;
    throw new BadRequestException("MENTIONED_AGENT_NOT_IN_SESSION");
  }

  /** 加载会话的所有成员 Agent */
  private async loadSessionMemberAgents(sessionId: string) {
    const participants = await this.prisma.sessionAgent.findMany({
      where: {
        sessionId,
        participantRole: "member",
        agent: { status: { not: "disabled" } },
      },
      orderBy: { createdAt: "asc" },
    });
    const ids = participants.map((participant) => participant.agentId);
    const agents = await this.agents.getAgents(ids);
    const ordered: AgentInstanceDto[] = [];
    for (const id of ids) {
      const agent = agents.find((item) => item.id === id);
      if (agent) ordered.push(agent);
    }
    return ordered;
  }

  /** 加载附件对应的消息部件 */
  private async loadAttachmentParts(sessionId: string, attachmentIds: string[]): Promise<HubMessagePartDto[]> {
    if (attachmentIds.length === 0) return [];
    const artifacts = await this.prisma.artifact.findMany({
      where: { id: { in: attachmentIds }, sessionId },
      orderBy: { createdAt: "asc" },
    });
    if (artifacts.length !== attachmentIds.length) throw new BadRequestException("ATTACHMENT_NOT_FOUND");
    return attachmentIds.map((id, index) => {
      const artifact = artifacts.find((item) => item.id === id)!;
      const metadata = mergeMetadata(artifact.metadata, {});
      const textPreview = typeof metadata.textPreview === "string" ? metadata.textPreview : null;
      const url = typeof metadata.url === "string" ? metadata.url : artifact.storageUri ?? undefined;
      return {
        id: `attachment_${index + 1}`,
        type: artifact.mimeType.startsWith("image/") ? "image" : "file",
        title: artifact.title,
        url,
        text: textPreview ?? undefined,
        metadata: {
          artifactId: artifact.id,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes == null ? null : Number(artifact.sizeBytes),
          sha256: artifact.sha256,
          textPreview,
        },
      };
    });
  }

  /** 加载引用消息的上下文文本块 */
  private async loadReferenceBlocks(
    sessionId: string,
    references: Array<{ messageId?: string; partId?: string; selectedText?: string; sourceLabel?: string }>,
  ): Promise<Array<{ label: string; text: string }>> {
    if (references.length === 0) return [];
    const messageIds = [...new Set(references.filter((item) => !item.selectedText).map((item) => item.messageId).filter((id): id is string => Boolean(id)))];
    const messages = await this.prisma.message.findMany({
      where: { sessionId, id: { in: messageIds } },
      include: { agent: true },
    });
    if (messages.length !== messageIds.length) throw new BadRequestException("REFERENCE_NOT_FOUND");
    const messagesById = new Map(messages.map((message) => [message.id, message]));
    return references.map((reference, index) => {
      if (reference.selectedText) {
        return { label: `${index + 1}. ${reference.sourceLabel ?? "selection"}`, text: reference.selectedText };
      }
      const message = reference.messageId ? messagesById.get(reference.messageId) : null;
      if (!message) throw new BadRequestException("REFERENCE_NOT_FOUND");
      const partText = reference.partId ? referencedPartText(message.contentJson, reference.partId) : null;
      if (reference.partId && partText == null) throw new BadRequestException("REFERENCE_PART_NOT_FOUND");
      const label = `${index + 1}. ${message.role}${message.agent?.name ? `:${message.agent.name}` : ""}`;
      return { label, text: partText ?? message.contentText };
    });
  }

  /** 插入或更新会话-Agent 关联 */
  private async upsertSessionAgent(sessionId: string, agentId: number, role: string, source: string) {
    await this.prisma.sessionAgent.upsert({
      where: { sessionId_agentId: { sessionId, agentId } },
      create: {
        sessionId,
        agentId,
        participantRole: role,
        source,
        firstMentionedAt: new Date(),
        lastActiveAt: new Date(),
      },
      update: {
        participantRole: role,
        source,
        lastActiveAt: new Date(),
      },
    });
  }

  /** 查找会话最新的运行 ID */
  private async findLatestRunId(sessionId: string): Promise<string | null> {
    const run = await this.prisma.agentRun.findFirst({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return run?.id ?? null;
  }

  /** 断言会话没有活跃的 run，否则抛出异常 */
  private async assertNoActiveRun(sessionId: string) {
    const activeRun = await this.findActiveRun(sessionId);
    if (activeRun) throw new BadRequestException("SESSION_HAS_ACTIVE_RUN");
  }

  private async hasActiveRun(sessionId: string) {
    return Boolean(await this.findActiveRun(sessionId));
  }

  private async findActiveRun(sessionId: string) {
    return this.prisma.agentRun.findFirst({
      where: {
        sessionId,
        status: { in: ["queued", "context_building", "connecting", "running"] },
      },
      select: { id: true },
    });
  }

  /** 断言会话处于活跃状态 */
  private async assertSessionActive(sessionId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { status: true },
    });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    if (session.status !== "active") throw new BadRequestException("SESSION_NOT_ACTIVE");
  }
}

/** 根据首条消息自动派生命名会话标题，手动标题不会被覆盖 */
export function deriveTitle(current: string, text: string, metadata: unknown) {
  if (mergeMetadata(metadata, {}).titleSource === "manual") return current;
  if (current && !isAutoTitlePlaceholder(current)) return current;
  const fallback = mergeMetadata(metadata, {}).mode === "direct" ? "新单聊" : "新 Agent 群聊";
  return text.replace(/\s+/g, " ").slice(0, 42) || fallback;
}

function isAutoTitlePlaceholder(value: string) {
  return value === "新单聊" || value === "新 Agent 群聊" || value === "Untitled Session";
}

function mergeMetadata(value: unknown, patch: Record<string, unknown>) {
  return {
    ...(value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}),
    ...patch,
  };
}

function normalizeLimit(value: number | undefined, fallback: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(number)));
}

function encodeSessionCursor(row: { id: string; updatedAt: Date | string; isPinned: boolean }) {
  return encodeCursor({
    id: row.id,
    updatedAt: new Date(row.updatedAt).toISOString(),
    pinned: Boolean(row.isPinned),
  });
}

function decodeSessionCursor(value: string | undefined) {
  const decoded = decodeCursor(value);
  if (!decoded) return null;
  if (typeof decoded.id !== "string" || typeof decoded.updatedAt !== "string") return null;
  return {
    id: decoded.id,
    updatedAt: decoded.updatedAt,
    pinned: decoded.pinned === true,
  };
}

function encodeMessageCursor(row: { id: string; createdAt: Date | string }) {
  return encodeCursor({
    id: row.id,
    createdAt: new Date(row.createdAt).toISOString(),
  });
}

function decodeMessageCursor(value: string | undefined) {
  const decoded = decodeCursor(value);
  if (!decoded) return null;
  if (typeof decoded.id !== "string" || typeof decoded.createdAt !== "string") return null;
  const createdAt = new Date(decoded.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { id: decoded.id, createdAt };
}

function encodeCursor(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function numberMetadataValue(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function withAttachmentPrompt(text: string, parts: HubMessagePartDto[]) {
  if (parts.length === 0) return text;
  const attachmentText = parts
    .map((part) => {
      const description = typeof part.metadata?.description === "string" ? `\n描述: ${part.metadata.description}` : "";
      const preview = part.text ? `\n预览:\n${part.text}` : "";
      return `- ${part.title ?? part.id} (${part.metadata?.mimeType ?? part.type}, ${part.metadata?.sizeBytes ?? 0} bytes)\nurl: ${part.url ?? ""}${description}${preview}`;
    })
    .join("\n");
  return `${text}\n\n附件：\n${attachmentText}`;
}

function withReferencePrompt(text: string, references: Array<{ label: string; text: string }>) {
  if (references.length === 0) return text;
  const quoted = references.map((item) => `### ${item.label}\n${item.text}`).join("\n\n");
  return `${text}\n\n引用上下文：\n${quoted}`;
}

type NormalizedReference = { messageId?: string; partId?: string; selectedText?: string; sourceLabel?: string };

function normalizeReferences(input: SendHubMessageRequest) {
  const references: NormalizedReference[] = Array.isArray(input.references)
    ? input.references
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          messageId: cleanString(item.messageId),
          partId: cleanString(item.partId),
          selectedText: cleanSelectedText(item.selectedText),
          sourceLabel: cleanSourceLabel(item.sourceLabel),
        }))
        .filter((item) => item.messageId || item.selectedText)
    : [];
  if (references.length === 0 && input.quotedMessageId) {
    references.push({ messageId: input.quotedMessageId });
  }
  const deduped = new Map<string, NormalizedReference>();
  for (const reference of references) {
    deduped.set(`${reference.messageId}:${reference.partId ?? ""}:${reference.selectedText ?? ""}`, reference);
  }
  return [...deduped.values()];
}

function firstReferenceMessageId(references: NormalizedReference[]) {
  return references.find((item) => item.messageId)?.messageId;
}

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanSelectedText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n/g, "\n").trim();
  return text ? text.slice(0, 8000) : undefined;
}

function cleanSourceLabel(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 80) : undefined;
}

/** 检测用户输入是否为部署命令（部署/发布/上线/deploy/vercel 等关键词） */
export function parseDeploymentCommand(text: string) {
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  if (!normalized || normalized.length > 32) return false;
  if (normalized.includes("不是") || normalized.includes("不要") || normalized.includes("解释")) return false;
  if (
    normalized.includes("容器") ||
    normalized.includes("container") ||
    normalized.includes("docker") ||
    normalized.includes("源码") ||
    normalized.includes("打包") ||
    normalized.includes("archive") ||
    normalized.includes("source")
  ) {
    return false;
  }
  const isDeployCommand =
    normalized.includes("部署") ||
    normalized.includes("发布") ||
    normalized.includes("上线") ||
    normalized.includes("deploy") ||
    normalized.includes("vercel");
  return isDeployCommand;
}

/** 获取被引用消息部件的上下文文本 */
export function referencedPartText(contentJson: unknown, partId: string) {
  const content = mergeMetadata(contentJson, {});
  if (!Array.isArray(content.parts)) return null;
  const part = content.parts
    .map((item) => mergeMetadata(item, {}))
    .find((item) => item.id === partId);
  if (!part) return null;
  return summarizePartForReference(part);
}

function summarizePartForReference(part: Record<string, unknown>) {
  return messagePartContextText(part) || null;
}

