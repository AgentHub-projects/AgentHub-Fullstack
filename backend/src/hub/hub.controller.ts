import { Body, Controller, Get, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import type {
  AddParticipantRequest,
  CreateHubSessionRequest,
  PinHubMessageRequest,
  SendHubMessageRequest,
} from "@agenthub/shared";
import { AgentRegistryService } from "./agent-registry.service";
import { ArtifactStorageService } from "./artifact-storage.service";
import { HubSessionService } from "./hub-session.service";
import { PrismaService } from "./prisma.service";
import { mapAgent, mapArtifact, mapEvent, mapFileChange } from "./hub.mappers";

@Controller("sessions")
export class HubSessionController {
  constructor(
    @Inject(HubSessionService)
    private readonly sessions: HubSessionService,
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  listSessions() {
    return this.sessions.listSessions();
  }

  @Post()
  createSession(@Body() body: CreateHubSessionRequest) {
    return this.sessions.createSession(body ?? {});
  }

  @Get(":sessionId")
  getSession(@Param("sessionId") sessionId: string) {
    return this.sessions.getDetail(sessionId);
  }

  @Post(":sessionId/messages")
  sendMessage(@Param("sessionId") sessionId: string, @Body() body: SendHubMessageRequest) {
    return this.sessions.sendMessage(sessionId, body);
  }

  @Post(":sessionId/messages/:messageId/pin")
  pinMessage(
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
    @Body() body: PinHubMessageRequest,
  ) {
    return this.sessions.pinMessage(sessionId, messageId, body);
  }

  @Post(":sessionId/participants")
  addParticipant(
    @Param("sessionId") sessionId: string,
    @Body() body: AddParticipantRequest,
  ) {
    return this.sessions.addParticipant(sessionId, body);
  }

  @Post(":sessionId/runs/:runId/cancel")
  cancelRun(@Param("sessionId") sessionId: string, @Param("runId") runId: string) {
    return this.sessions.cancelRun(sessionId, runId);
  }

  @Get(":sessionId/events")
  async listEvents(@Param("sessionId") sessionId: string) {
    const items = await this.prisma.agentEvent.findMany({
      where: { sessionId },
      orderBy: [{ persistedAt: "asc" }, { seq: "asc" }],
      take: 1000,
    });
    return { items: items.map(mapEvent) };
  }

  @Get(":sessionId/artifacts")
  async listArtifacts(@Param("sessionId") sessionId: string) {
    const items = await this.prisma.artifact.findMany({
      where: { sessionId },
      orderBy: { updatedAt: "desc" },
    });
    return { items: items.map(mapArtifact) };
  }

  @Get(":sessionId/file-changes")
  async listFileChanges(@Param("sessionId") sessionId: string) {
    const items = await this.prisma.fileChange.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
    });
    return { items: items.map(mapFileChange) };
  }
}

@Controller("agents")
export class HubAgentController {
  constructor(@Inject(AgentRegistryService) private readonly agents: AgentRegistryService) {}

  @Get()
  listAgents() {
    return this.agents.listAgents().then((items) => ({ items }));
  }

  @Get("templates")
  listTemplates() {
    return this.agents.listTemplates().then((items) => ({ items }));
  }

  @Get(":id/detail")
  async getAgentDetail(@Param("id") id: string) {
    const agent = await this.agents.getAgent(id);
    if (!agent) {
      throw Object.assign(new Error("Agent not found"), { statusCode: 404 });
    }
    return { agent, template: agent.template ?? null };
  }
}

@Controller("artifacts")
export class HubArtifactController {
  constructor(@Inject(ArtifactStorageService) private readonly artifacts: ArtifactStorageService) {}

  @Get(":artifactId/content")
  async getArtifactContent(@Param("artifactId") artifactId: string, @Res() response: Response) {
    const content = await this.artifacts.getContent(artifactId);
    if (!content) {
      response.status(404).json({ code: "NOT_FOUND", message: "Artifact not found" });
      return;
    }
    if (content.redirectUrl) {
      response.redirect(content.redirectUrl);
      return;
    }
    response.type(content.contentType).send(content.body ?? "");
  }
}

@Controller("health")
export class HubHealthController {
  @Get()
  health() {
    return { ok: true, service: "agenthub-backend", ts: new Date().toISOString() };
  }
}
