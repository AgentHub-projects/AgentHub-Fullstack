import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type {
  AddParticipantRequest,
  CreateHubSessionRequest,
  CreateSessionAgentRequest,
  PinHubMessageRequest,
  SendHubMessageRequest,
  UpdateHubSessionRequest,
  UpdateAgentRequest,
} from "@agenthub/shared";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { mapAgent, mapArtifact, mapEvent, mapFileChange, mapSession } from "../mappers/hub.mappers";
import { PublicRoute } from "../auth/public.decorator";
import { AgentRegistryService } from "../services/agent-registry.service";
import { ArtifactStorageService } from "../services/artifact-storage.service";
import { HubSessionService } from "../services/hub-session.service";
import { PrismaService } from "../services/prisma.service";

@Controller("sessions")
export class HubSessionController {
  constructor(
    @Inject(HubSessionService)
    private readonly sessions: HubSessionService,
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  listSessions(@Query("q") query?: string, @Query("includeArchived") includeArchived?: string) {
    return this.sessions.listSessions({
      query,
      includeArchived: includeArchived === "true",
    });
  }

  @Post()
  createSession(@Body() body: CreateHubSessionRequest) {
    return this.sessions.createSession(body ?? {});
  }

  @Get(":sessionId")
  getSession(@Param("sessionId") sessionId: string) {
    return this.sessions.getDetail(sessionId);
  }

  @Patch(":sessionId")
  updateSession(@Param("sessionId") sessionId: string, @Body() body: UpdateHubSessionRequest) {
    return this.sessions.updateSession(sessionId, body ?? {});
  }

  @Post(":sessionId/archive")
  archiveSession(@Param("sessionId") sessionId: string) {
    return this.sessions.archiveSession(sessionId);
  }

  @Delete(":sessionId")
  deleteSession(@Param("sessionId") sessionId: string) {
    return this.sessions.deleteSession(sessionId);
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
  constructor(
    @Inject(AgentRegistryService) private readonly agents: AgentRegistryService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HubRealtimeGateway) private readonly gateway: HubRealtimeGateway,
  ) {}

  @Get()
  listAgents() {
    return this.agents.listAgents().then((items) => ({ items }));
  }

  @Get(":id/detail")
  async getAgentDetail(@Param("id") id: string) {
    const agent = await this.agents.getAgent(Number(id));
    if (!agent) {
      throw Object.assign(new Error("Agent not found"), { statusCode: 404 });
    }
    return { agent, template: agent.template ?? null };
  }

  @Post()
  async createAgent(@Body() body: CreateSessionAgentRequest) {
    const agent = await this.agents.createAgentFromTemplate(
      body.sessionId,
      body.templateId,
      body.provider,
      body.name,
    );
    // Push updated session via WebSocket
    const session = await this.prisma.session.findUnique({
      where: { id: body.sessionId },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (session) {
      this.gateway.emitSession(mapSession(session));
    }
    return agent;
  }

  @Get(":id/prompt")
  async getAgentPrompt(@Param("id") id: string) {
    return this.agents.getAgentPrompt(Number(id));
  }

  @Patch(":id")
  async updateAgent(@Param("id") id: string, @Body() body: UpdateAgentRequest) {
    return this.agents.updateAgent(Number(id), body);
  }

  @Delete(":id")
  async deleteAgent(@Param("id") id: string) {
    const agentId = Number(id);
    const agent = await this.agents.getAgent(agentId);
    if (!agent) {
      throw Object.assign(new Error("Agent not found"), { statusCode: 404 });
    }
    const links = await this.prisma.sessionAgent.findMany({ where: { agentId } });
    await this.agents.deleteAgent(agentId);
    for (const link of links) {
      const session = await this.prisma.session.findUnique({
        where: { id: link.sessionId },
        include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      if (session) this.gateway.emitSession(mapSession(session));
    }
    return { ok: true };
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

@Controller()
export class HubUploadController {
  constructor(@Inject(ArtifactStorageService) private readonly artifacts: ArtifactStorageService) {}

  @Post("sessions/:sessionId/uploads")
  async uploadAttachment(@Param("sessionId") sessionId: string, @Req() request: Request) {
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (!sessionId) throw new BadRequestException("SESSION_ID_REQUIRED");
    if (contentLength > MAX_UPLOAD_BYTES) throw new BadRequestException("UPLOAD_TOO_LARGE");
    const data = await readRequestBuffer(request, MAX_UPLOAD_BYTES);
    if (data.length === 0) throw new BadRequestException("UPLOAD_EMPTY");
    const name = decodeHeaderValue(headerString(request.headers["x-file-name"]) ?? "attachment");
    const mimeType = headerString(request.headers["content-type"]) ?? "application/octet-stream";
    return this.artifacts.createAttachment({ sessionId, name, mimeType, data });
  }

  @PublicRoute()
  @Get("uploads/:artifactId/content")
  async getUploadedContent(@Param("artifactId") artifactId: string, @Res() response: Response) {
    const content = await this.artifacts.getUploadedContent(artifactId);
    if (!content) {
      response.status(404).json({ code: "NOT_FOUND", message: "Upload not found" });
      return;
    }
    if ("redirectUrl" in content && content.redirectUrl) {
      response.redirect(content.redirectUrl);
      return;
    }
    response.type(content.contentType).send(content.body ?? "");
  }
}

@PublicRoute()
@Controller("downstream")
export class DownstreamController {
  constructor(@Inject(AgentRegistryService) private readonly agents: AgentRegistryService) {}

  @Get("agents/:agentId/config")
  async getAgentConfig(@Param("agentId") agentId: string) {
    if (!/^\d+$/.test(agentId)) throw new BadRequestException("AGENT_ID_INVALID");
    const config = await this.agents.getDownstreamConfig(Number(agentId));
    if (!config) throw new NotFoundException("AGENT_NOT_FOUND");
    return config;
  }
}

@PublicRoute()
@Controller("health")
export class HubHealthController {
  @Get()
  health() {
    return { ok: true, service: "agenthub-backend", ts: new Date().toISOString() };
  }
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

async function readRequestBuffer(request: Request, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request as any as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new BadRequestException("UPLOAD_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function headerString(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function decodeHeaderValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
