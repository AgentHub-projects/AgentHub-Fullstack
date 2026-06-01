import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AddParticipantRequest,
  CreateHubSessionRequest,
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
        participants: { include: { agent: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    const filtered = query ? sessions.filter((session) => sessionMatchesQuery(session, query)) : sessions;
    filtered.sort(compareSessionsForList);
    return { items: filtered.map(mapSession) };
  }

  async createSession(input: CreateHubSessionRequest) {
    const session = await this.prisma.session.create({
      data: {
        title: input.title?.trim() || "新 Agent 群聊",
        metadata: {
          ...(input.metadata ?? {}),
          isPinned: Boolean(input.metadata?.isPinned),
          titleSource: input.title?.trim() ? "manual" : "auto",
        } as any,
      },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });

    // Create agent instances from templates
    let orchestratorAgentId: number | null = null;
    const memberAgentIds: number[] = [];
    if (input.orchestratorTemplateId) {
      const tpl = await this.prisma.agentTemplate.findUnique({
        where: { id: input.orchestratorTemplateId },
      });
      if (tpl) {
        const providerId = input.orchestratorProvider
          ? await this.agents.resolveProviderId(input.orchestratorProvider)
          : tpl.defaultProviderId;
        const agent = await this.prisma.agent.create({
          data: {
            templateId: tpl.id,
            name: input.orchestratorName || `${tpl.name.replace(/\s+/g, "-").toLowerCase()}-${session.id.slice(0, 8)}`,
            description: tpl.description,
            providerId,
            isDefaultOrchestrator: false,
            status: "enabled",
          },
        });
        await this.prisma.sessionAgent.create({
          data: {
            sessionId: session.id,
            agentId: agent.id,
            participantRole: "orchestrator",
            source: "manual_add",
            firstMentionedAt: new Date(),
            lastActiveAt: new Date(),
          },
        });
        orchestratorAgentId = agent.id;
      }
    }

    if (input.memberTemplates?.length) {
      for (const mt of input.memberTemplates) {
        const tpl = await this.prisma.agentTemplate.findUnique({
          where: { id: mt.templateId },
        });
        if (tpl) {
          const providerId = mt.provider
            ? await this.agents.resolveProviderId(mt.provider)
            : tpl.defaultProviderId;
          const agent = await this.prisma.agent.create({
            data: {
              templateId: tpl.id,
              name: mt.name || `${tpl.name.replace(/\s+/g, "-").toLowerCase()}-${session.id.slice(0, 8)}`,
              description: tpl.description,
              providerId,
              isDefaultOrchestrator: false,
              status: "enabled",
            },
          });
          await this.prisma.sessionAgent.create({
            data: {
              sessionId: session.id,
              agentId: agent.id,
              participantRole: "member",
              source: "manual_add",
              firstMentionedAt: new Date(),
              lastActiveAt: new Date(),
            },
          });
          memberAgentIds.push(agent.id);
        }
      }
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        metadata: mergeMetadata(session.metadata, {
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

    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    if (session.status !== "active") throw new BadRequestException("SESSION_NOT_ACTIVE");

    const orchestrator = input.orchestratorAgentId
      ? await this.agents.getAgent(input.orchestratorAgentId)
      : await this.agents.getDefaultOrchestrator();
    if (!orchestrator) throw new Error("Orchestrator agent not found");

    const mentionedAgents = await this.resolveMentions(sessionId, text, input.mentionedAgentIds ?? []);
    const message = await this.prisma.message.create({
      data: {
        sessionId,
        role: "user",
        parentMessageId: input.parentMessageId,
        contentText: text,
        contentJson: { mentionedAgentIds: mentionedAgents.map((agent) => agent.id) },
        tokenCount: this.context.estimateTokens(text),
      },
    });

    await this.context.recordContextItem({
      sessionId,
      sourceType: "message",
      sourceId: message.id,
      kind: "message",
      text,
      importance: 20,
    });

    const run = await this.prisma.agentRun.create({
      data: {
        sessionId,
        orchestratorAgentId: orchestrator.id,
        userMessageId: message.id,
        status: "queued",
      },
    });

    await this.upsertSessionAgent(sessionId, orchestrator.id, "orchestrator", "default_orchestrator");
    for (const agent of mentionedAgents) {
      await this.upsertSessionAgent(sessionId, agent.id, "member", "mention");
    }

    const contextSnapshot = await this.context.buildSnapshot({
      sessionId,
      runId: run.id,
      promptText: text,
      mentionedAgents,
    });

    const updatedRun = await this.prisma.agentRun.update({
      where: { id: run.id },
      data: { contextSnapshotId: contextSnapshot.id },
    });
    const updatedSession = await this.prisma.session.update({
      where: { id: sessionId },
      data: { title: deriveTitle(session.title, text, session.metadata), updatedAt: new Date() },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });

    const sessionDto = mapSession(updatedSession);
    this.gateway.emitSession(sessionDto);
    this.gateway.emitContext(sessionId, contextSnapshot);
    await this.events.append({
      sessionId,
      runId: run.id,
      eventType: "run.created",
      speakerAgentId: orchestrator.id,
      source: "agenthub_backend",
      payload: {
        status: "queued",
        orchestratorAgentId: orchestrator.id,
        mentionedAgentIds: mentionedAgents.map((agent) => agent.id),
        mentionedAgentNames: mentionedAgents.map((agent) => agent.name),
        contextSnapshotId: contextSnapshot.id,
      },
    });

    void this.downstream.startRun({
      sessionId,
      runId: run.id,
      userMessageId: message.id,
      promptText: text,
      orchestrator,
      mentionedAgents,
      context: contextSnapshot,
    });

    return {
      session: sessionDto,
      message: mapMessage(message),
      run: mapRun(updatedRun),
      contextSnapshot,
    };
  }

  async pinMessage(sessionId: string, messageId: string, input: PinHubMessageRequest) {
    const message = await this.context.setMessagePinned(sessionId, messageId, input.pinned);
    const mapped = mapMessage(message);
    await this.events.append({
      sessionId,
      runId: message.runId ?? (await this.getLatestRunId(sessionId)),
      eventType: "context.updated",
      source: "agenthub_backend",
      payload: { messageId, pinned: input.pinned },
    });
    return mapped;
  }

  async cancelRun(sessionId: string, runId: string) {
    const run = await this.prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error("Run not found");
    await this.downstream.cancelRun(sessionId, runId, run.orchestratorAgentId);
    return { runId, status: "cancelled" };
  }

  private async resolveMentions(sessionId: string, text: string, explicitIds: number[]) {
    const agents = await this.agents.listAgents();
    const ids = new Set(explicitIds);

    // Check text for @mentions
    const lowerText = text.toLowerCase();
    for (const agent of agents) {
      const labels = [`@${agent.name}`, `@${agent.id}`].map((label) => label.toLowerCase());
      if (labels.some((label) => lowerText.includes(label))) {
        ids.add(agent.id);
      }
    }

    // Also include session participants (group members)
    if (ids.size === 0) {
      const participants = await this.prisma.sessionAgent.findMany({
        where: { sessionId },
      });
      const participantAgents = agents.filter((agent) =>
        participants.some((p) => p.agentId === agent.id && p.participantRole !== "orchestrator"),
      );
      return participantAgents.length > 0
        ? participantAgents
        : agents.filter((agent) => !agent.isDefaultOrchestrator).slice(0, 2);
    }

    const mentioned = agents.filter((agent) => ids.has(agent.id));
    if (mentioned.length > 0) return mentioned;
    return agents.filter((agent) => !agent.isDefaultOrchestrator).slice(0, 2);
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
