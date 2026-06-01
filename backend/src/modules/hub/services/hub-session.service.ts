import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AddParticipantRequest,
  AgentInstanceDto,
  CreateHubSessionRequest,
  DeploymentTarget,
  HubMessagePartDto,
  PinHubMessageRequest,
  SendHubMessageRequest,
  SendHubMessageResponse,
  SessionDetailDto,
  UpdateHubSessionRequest,
} from "@agenthub/shared";
import { AgentRegistryService } from "./agent-registry.service";
import { HubContextService } from "./context.service";
import { DownstreamOrchestratorService } from "./downstream-orchestrator.service";
import { HubEventService } from "./event.service";
import { DeploymentService } from "./deployment.service";
import {
  mapArtifact,
  mapContextSnapshot,
  mapEvent,
  mapFileChange,
  mapMessage,
  mapRun,
  mapSession,
} from "../mappers/hub.mappers";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { PrismaService } from "./prisma.service";
import { buildLinkPreviewParts, messageJsonWithParts } from "../utils/message-parts";

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
  ) {}

  async listSessions(input: { query?: string; includeArchived?: boolean } = {}) {
    const query = input.query?.trim().toLowerCase() ?? "";
    const sessions = await this.prisma.session.findMany({
      where: input.includeArchived ? { status: { not: "deleted" } } : { status: "active" },
      include: {
        runs: { orderBy: { createdAt: "desc" }, take: 1 },
        messages: { orderBy: { createdAt: "desc" }, take: 5, select: { contentText: true } },
        participants: { where: { participantRole: { not: "deleted" } }, include: { agent: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    const filtered = query ? sessions.filter((session) => sessionMatchesQuery(session, query)) : sessions;
    filtered.sort(compareSessionsForList);
    return { items: filtered.map(mapSession) };
  }

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
    return dto;
  }

  async getDetail(sessionId: string): Promise<SessionDetailDto> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!session || session.status === "deleted") {
      throw new NotFoundException("SESSION_NOT_FOUND");
    }
    const [messages, runs, events, artifacts, fileChanges, contextSnapshot] = await Promise.all([
      this.prisma.message.findMany({
        where: { sessionId },
        include: { agent: true },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.agentRun.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.agentEvent.findMany({
        where: { sessionId },
        orderBy: [{ persistedAt: "asc" }, { seq: "asc" }],
        take: 1000,
      }),
      this.prisma.artifact.findMany({
        where: { sessionId },
        orderBy: { updatedAt: "desc" },
      }),
      this.prisma.fileChange.findMany({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.contextSnapshot.findFirst({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return {
      session: mapSession(session),
      messages: messages.map(mapMessage),
      runs: runs.map(mapRun),
      events: events.map(mapEvent),
      artifacts: artifacts.map(mapArtifact),
      fileChanges: fileChanges.map(mapFileChange),
      context: contextSnapshot ? mapContextSnapshot(contextSnapshot) : null,
    };
  }

  async addParticipant(sessionId: string, input: AddParticipantRequest) {
    const currentSession = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { status: true, metadata: true },
    });
    if (!currentSession || currentSession.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    if (currentSession.status !== "active") throw new BadRequestException("SESSION_NOT_ACTIVE");

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

    await this.events.append({
      sessionId,
      runId: await this.getLatestRunId(sessionId),
      eventType: "context.updated",
      source: "agenthub_backend",
      payload: { action: "participant_added", agentId: input.agentId, agentName: agent.name },
    });

    return { session: sessionDto, agent };
  }

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
    const deploymentTarget = parseDeploymentCommandTarget(text);
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
            quotedMessageId: input.quotedMessageId ?? references[0]?.messageId,
            quotedMessageIds: references.map((item) => item.messageId),
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

    const run = await this.prisma.agentRun.create({
      data: {
        sessionId,
        orchestratorAgentId: runAgent.id,
        userMessageId: message.id,
        status: deploymentTarget ? "completed" : "queued",
        completedAt: deploymentTarget ? new Date() : undefined,
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
        status: deploymentTarget ? "completed" : "queued",
        command: deploymentTarget ? "deployment" : undefined,
        deploymentTarget,
        orchestratorAgentId: runAgent.id,
        mode: isDirect ? "direct" : "group",
        mentionedAgentIds: mentionedAgents.map((agent) => agent.id),
        mentionedAgentNames: mentionedAgents.map((agent) => agent.name),
      },
    });

    if (deploymentTarget) {
      await this.events.append({
        sessionId,
        runId: run.id,
        eventType: "run.completed",
        speakerAgentId: runAgent.id,
        source: "agenthub_backend",
        payload: {
          status: "completed",
          command: "deployment",
          deploymentTarget,
        },
      });
      await this.deployments.start(sessionId, { target: deploymentTarget });
      return {
        session: sessionDto,
        message: mapMessage(message),
        run: mapRun(run),
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

  async pinMessage(sessionId: string, messageId: string, input: PinHubMessageRequest) {
    const message = input.partId
      ? await this.context.setMessagePartPinned(sessionId, messageId, input.partId, input.pinned)
      : await this.context.setMessagePinned(sessionId, messageId, input.pinned);
    const mapped = mapMessage(message);
    await this.events.append({
      sessionId,
      runId: message.runId ?? (await this.getLatestRunId(sessionId)),
      eventType: "context.updated",
      source: "agenthub_backend",
      payload: { messageId, partId: input.partId, pinned: input.pinned },
    });
    this.downstream.notifyPinUpdated(sessionId, { messageId, partId: input.partId, pinned: input.pinned });
    return mapped;
  }

  async cancelRun(sessionId: string, runId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error("Run not found");
    await this.downstream.cancelRun(sessionId, runId, run.orchestratorAgentId);
    return { runId, status: "cancelled" };
  }

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
            messageId: typeof item.messageId === "string" ? item.messageId : "",
            partId: typeof item.partId === "string" ? item.partId : undefined,
          }))
          .filter((item) => item.messageId)
      : undefined;
    return this.sendMessage(sessionId, {
      content: message.contentText,
      parentMessageId: message.parentMessageId ?? undefined,
      quotedMessageId: typeof contentJson.quotedMessageId === "string" ? contentJson.quotedMessageId : undefined,
      references,
      attachments: attachmentIds.map((id) => ({ id })),
    });
  }

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

  async applyFileChange(sessionId: string, fileChangeId: string) {
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

  private async resolveSessionOrchestrator(metadata: Record<string, unknown>, requestedAgentId?: number) {
    const orchestratorAgentId = numberMetadataValue(metadata.orchestratorAgentId) ?? requestedAgentId;
    if (orchestratorAgentId) return this.agents.getAgent(orchestratorAgentId);
    return this.agents.getDefaultOrchestrator();
  }

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

  private async loadReferenceBlocks(
    sessionId: string,
    references: Array<{ messageId: string; partId?: string }>,
  ): Promise<Array<{ label: string; text: string }>> {
    if (references.length === 0) return [];
    const messageIds = [...new Set(references.map((item) => item.messageId))];
    const messages = await this.prisma.message.findMany({
      where: { sessionId, id: { in: messageIds } },
      include: { agent: true },
    });
    if (messages.length !== messageIds.length) throw new BadRequestException("REFERENCE_NOT_FOUND");
    return references.map((reference, index) => {
      const message = messages.find((item) => item.id === reference.messageId)!;
      const partText = reference.partId ? referencedPartText(message.contentJson, reference.partId) : null;
      if (reference.partId && partText == null) throw new BadRequestException("REFERENCE_PART_NOT_FOUND");
      const label = `${index + 1}. ${message.role}${message.agent?.name ? `:${message.agent.name}` : ""}`;
      return { label, text: partText ?? message.contentText };
    });
  }

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

  private async getLatestRunId(sessionId: string): Promise<string> {
    const run = await this.prisma.agentRun.findFirst({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
    });
    if (!run) {
      const orchestrator = await this.agents.getDefaultOrchestrator();
      const created = await this.prisma.agentRun.create({
        data: { sessionId, orchestratorAgentId: orchestrator.id, status: "queued" },
      });
      return created.id;
    }
    return run.id;
  }

  private async assertNoActiveRun(sessionId: string) {
    const activeRun = await this.prisma.agentRun.findFirst({
      where: {
        sessionId,
        status: { in: ["queued", "context_building", "connecting", "running"] },
      },
      select: { id: true },
    });
    if (activeRun) throw new BadRequestException("SESSION_HAS_ACTIVE_RUN");
  }
}

function deriveTitle(current: string, text: string, metadata: unknown) {
  if (mergeMetadata(metadata, {}).titleSource === "manual") return current;
  if (current && current !== "新 Agent 群聊" && current !== "Untitled Session") return current;
  return text.replace(/\s+/g, " ").slice(0, 42) || "新 Agent 群聊";
}

function mergeMetadata(value: unknown, patch: Record<string, unknown>) {
  return {
    ...(value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}),
    ...patch,
  };
}

function compareSessionsForList(a: { metadata: unknown; updatedAt: Date }, b: { metadata: unknown; updatedAt: Date }) {
  const pinnedDiff = Number(sessionPinned(b)) - Number(sessionPinned(a));
  if (pinnedDiff !== 0) return pinnedDiff;
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

function sessionPinned(session: { metadata: unknown }) {
  return mergeMetadata(session.metadata, {}).isPinned === true;
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
      const description = typeof part.metadata?.description === "string" ? `\ndescription: ${part.metadata.description}` : "";
      const preview = part.text ? `\ntextPreview:\n${part.text}` : "";
      return `- ${part.title ?? part.id} (${part.metadata?.mimeType ?? part.type}, ${part.metadata?.sizeBytes ?? 0} bytes)\nurl: ${part.url ?? ""}${description}${preview}`;
    })
    .join("\n");
  return `${text}\n\nAttachments:\n${attachmentText}`;
}

function withReferencePrompt(text: string, references: Array<{ label: string; text: string }>) {
  if (references.length === 0) return text;
  const quoted = references.map((item) => `### ${item.label}\n${item.text}`).join("\n\n");
  return `${text}\n\nQuoted context:\n${quoted}`;
}

function normalizeReferences(input: SendHubMessageRequest) {
  const references: Array<{ messageId: string; partId?: string }> = Array.isArray(input.references)
    ? input.references
        .filter((item) => item && typeof item.messageId === "string" && item.messageId.trim())
        .map((item) => ({ messageId: item.messageId, partId: item.partId }))
    : [];
  if (references.length === 0 && input.quotedMessageId) {
    references.push({ messageId: input.quotedMessageId });
  }
  const deduped = new Map<string, { messageId: string; partId?: string }>();
  for (const reference of references) {
    deduped.set(`${reference.messageId}:${reference.partId ?? ""}`, reference);
  }
  return [...deduped.values()];
}

export function parseDeploymentCommandTarget(text: string): DeploymentTarget | null {
  const normalized = text.replace(/\s+/g, "").toLowerCase();
  if (!normalized || normalized.length > 32) return null;
  if (normalized.includes("不是") || normalized.includes("不要") || normalized.includes("解释")) return null;
  const isDeployCommand =
    normalized.includes("部署") ||
    normalized.includes("发布") ||
    normalized.includes("deploy") ||
    normalized.includes("打包") ||
    normalized.includes("源码包");
  if (!isDeployCommand) return null;
  if (normalized.includes("容器") || normalized.includes("container") || normalized.includes("docker")) return "container";
  if (
    normalized.includes("源码") ||
    normalized.includes("打包") ||
    normalized.includes("archive") ||
    normalized.includes("source")
  ) {
    return "source_archive";
  }
  return "static";
}

function referencedPartText(contentJson: unknown, partId: string) {
  const content = mergeMetadata(contentJson, {});
  if (!Array.isArray(content.parts)) return null;
  const part = content.parts
    .map((item) => mergeMetadata(item, {}))
    .find((item) => item.id === partId);
  return typeof part?.text === "string" ? part.text : null;
}

function sessionMatchesQuery(
  session: {
    title: string;
    messages?: Array<{ contentText: string }>;
    participants?: Array<{ agent?: { name?: string | null } | null }>;
  },
  query: string,
) {
  if (session.title.toLowerCase().includes(query)) return true;
  if (session.messages?.some((message) => message.contentText.toLowerCase().includes(query))) return true;
  return Boolean(session.participants?.some((item) => item.agent?.name?.toLowerCase().includes(query)));
}
