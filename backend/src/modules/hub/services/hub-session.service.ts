import { Inject, Injectable } from "@nestjs/common";
import type {
  AddParticipantRequest,
  CreateHubSessionRequest,
  PinHubMessageRequest,
  SendHubMessageRequest,
  SendHubMessageResponse,
  SessionDetailDto,
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

  async listSessions() {
    const sessions = await this.prisma.session.findMany({
      where: { status: { not: "deleted" } },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
    });
    return { items: sessions.map(mapSession) };
  }

  async createSession(input: CreateHubSessionRequest) {
    const session = await this.prisma.session.create({
      data: {
        title: input.title?.trim() || "新 Agent 群聊",
        metadata: (input.metadata ?? {}) as any,
      },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });

    // Create agent instances from templates
    if (input.orchestratorTemplateId) {
      const tpl = await this.prisma.agentTemplate.findUnique({
        where: { id: input.orchestratorTemplateId },
      });
      if (tpl) {
        const provider = input.orchestratorProvider ?? tpl.defaultProvider;
        const agent = await this.prisma.agent.create({
          data: {
            templateId: tpl.id,
            name: `${tpl.name.replace(/\s+/g, "-").toLowerCase()}-${session.id.slice(0, 8)}`,
            description: tpl.description,
            provider,
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
      }
    }

    if (input.memberTemplates?.length) {
      for (const mt of input.memberTemplates) {
        const tpl = await this.prisma.agentTemplate.findUnique({
          where: { id: mt.templateId },
        });
        if (tpl) {
          const provider = mt.provider ?? tpl.defaultProvider;
          const agent = await this.prisma.agent.create({
            data: {
              templateId: tpl.id,
              name: `${tpl.name.replace(/\s+/g, "-").toLowerCase()}-${session.id.slice(0, 8)}`,
              description: tpl.description,
              provider,
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
        }
      }
    }

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
    if (!session) {
      throw new Error("Session not found");
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

    const session = await this.prisma.session.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
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

  async sendMessage(sessionId: string, input: SendHubMessageRequest): Promise<SendHubMessageResponse> {
    const text = input.content.trim();
    if (!text) throw new Error("Message content is required");

    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new Error("Session not found");

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
      data: { title: deriveTitle(session.title, text), updatedAt: new Date() },
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

  private async resolveMentions(sessionId: string, text: string, explicitIds: string[]) {
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

  private async upsertSessionAgent(sessionId: string, agentId: string, role: string, source: string) {
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
}

function deriveTitle(current: string, text: string) {
  if (current && current !== "新 Agent 群聊" && current !== "Untitled Session") return current;
  return text.replace(/\s+/g, " ").slice(0, 42) || "新 Agent 群聊";
}
