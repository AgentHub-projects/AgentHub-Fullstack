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
  CreateProjectRequest,
  CreateHubSessionRequest,
  CreateSessionAgentRequest,
  PinHubMessageRequest,
  SandboxConnectRequest,
  SandboxFileChangeCallbackRequest,
  SendHubMessageRequest,
  StartDeploymentRequest,
  UpdateHubSessionRequest,
  UpdateAgentRequest,
  UpdateProjectRequest,
} from "@agenthub/shared";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { mapAgent, mapArtifact, mapEvent, mapFileChange, mapProject, mapSession } from "../mappers/hub.mappers";
import { PublicRoute } from "../auth/public.decorator";
import { AgentRegistryService } from "../services/agent-registry.service";
import { ArtifactStorageService } from "../services/artifact-storage.service";
import { HubSessionService } from "../services/hub-session.service";
import { DeploymentService } from "../services/deployment.service";
import { DownstreamOrchestratorService } from "../services/downstream-orchestrator.service";
import { SandboxService } from "../services/sandbox.service";
import { PrismaService } from "../services/prisma.service";

/** 会话控制器：管理会话 CRUD、消息、成员、运行和部署 */
@Controller("sessions")
export class HubSessionController {
  constructor(
    @Inject(HubSessionService)
    private readonly sessions: HubSessionService,
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(HubRealtimeGateway)
    private readonly gateway: HubRealtimeGateway,
    @Inject(DeploymentService)
    private readonly deployments: DeploymentService,
  ) {}

  /** 列出会话 */
  @Get()
  listSessions(@Query("q") query?: string, @Query("includeArchived") includeArchived?: string) {
    return this.sessions.listSessions({
      query,
      includeArchived: includeArchived === "true",
    });
  }

  /** 创建会话 */
  @Post()
  createSession(@Body() body: CreateHubSessionRequest) {
    return this.sessions.createSession(body ?? {});
  }

  /** 获取会话详情 */
  @Get(":sessionId")
  getSession(@Param("sessionId") sessionId: string) {
    return this.sessions.getDetail(sessionId);
  }

  /** 获取 Diff 审查范围说明 */
  @Get(":sessionId/diff-context")
  getDiffContext(@Param("sessionId") sessionId: string) {
    return this.sessions.getDiffContext(sessionId);
  }

  /** 更新会话 */
  @Patch(":sessionId")
  updateSession(@Param("sessionId") sessionId: string, @Body() body: UpdateHubSessionRequest) {
    return this.sessions.updateSession(sessionId, body ?? {});
  }

  /** 归档会话 */
  @Post(":sessionId/archive")
  archiveSession(@Param("sessionId") sessionId: string) {
    return this.sessions.archiveSession(sessionId);
  }

  /** 删除会话 */
  @Delete(":sessionId")
  deleteSession(@Param("sessionId") sessionId: string) {
    return this.sessions.deleteSession(sessionId);
  }

  /** 绑定/解绑项目到会话 */
  @Post(":sessionId/project")
  async bindProject(@Param("sessionId") sessionId: string, @Body() body: { projectId?: string | null }) {
    await assertSessionActive(this.prisma, sessionId);
    const projectId = body?.projectId ?? null;
    if (projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: projectId, status: "active" } });
      if (!project) throw new NotFoundException("PROJECT_NOT_FOUND");
    }
    const session = await this.prisma.session.update({
      where: { id: sessionId },
      data: { projectId, updatedAt: new Date() },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const dto = mapSession(session);
    this.gateway.emitSession(dto);
    return dto;
  }

  /** 发送消息 */
  @Post(":sessionId/messages")
  sendMessage(@Param("sessionId") sessionId: string, @Body() body: SendHubMessageRequest) {
    return this.sessions.sendMessage(sessionId, body);
  }

  /** 置顶/取消置顶消息 */
  @Post(":sessionId/messages/:messageId/pin")
  pinMessage(
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
    @Body() body: PinHubMessageRequest,
  ) {
    return this.sessions.pinMessage(sessionId, messageId, body);
  }

  /** 重新生成消息回复 */
  @Post(":sessionId/messages/:messageId/regenerate")
  regenerateMessage(@Param("sessionId") sessionId: string, @Param("messageId") messageId: string) {
    return this.sessions.regenerateFromMessage(sessionId, messageId);
  }

  /** 添加参与者 */
  @Post(":sessionId/participants")
  addParticipant(
    @Param("sessionId") sessionId: string,
    @Body() body: AddParticipantRequest,
  ) {
    return this.sessions.addParticipant(sessionId, body);
  }

  /** 取消运行 */
  @Post(":sessionId/runs/:runId/cancel")
  cancelRun(@Param("sessionId") sessionId: string, @Param("runId") runId: string) {
    return this.sessions.cancelRun(sessionId, runId);
  }

  /** 列出会话事件 */
  @Get(":sessionId/events")
  async listEvents(@Param("sessionId") sessionId: string) {
    const items = await this.prisma.agentEvent.findMany({
      where: { sessionId },
      orderBy: [{ persistedAt: "asc" }, { seq: "asc" }],
      take: 1000,
    });
    return { items: items.map(mapEvent) };
  }

  /** 列出会话产物 */
  @Get(":sessionId/artifacts")
  async listArtifacts(@Param("sessionId") sessionId: string) {
    const items = await this.prisma.artifact.findMany({
      where: { sessionId },
      orderBy: { updatedAt: "desc" },
    });
    return { items: items.map(mapArtifact) };
  }

  /** 列出文件变更 */
  @Get(":sessionId/file-changes")
  async listFileChanges(@Param("sessionId") sessionId: string) {
    const items = await this.prisma.fileChange.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
    });
    return { items: items.map(mapFileChange) };
  }

  /** 应用文件变更 */
  @Post(":sessionId/file-changes/:fileChangeId/apply")
  applyFileChange(@Param("sessionId") sessionId: string, @Param("fileChangeId") fileChangeId: string) {
    return this.sessions.applyFileChange(sessionId, fileChangeId);
  }

  /** 部署预检 */
  @Get(":sessionId/deployments/preflight")
  preflightDeployment(@Param("sessionId") sessionId: string) {
    return this.deployments.preflight(sessionId);
  }

  /** 启动部署 */
  @Post(":sessionId/deployments")
  async startDeployment(@Param("sessionId") sessionId: string, @Body() body: StartDeploymentRequest) {
    await assertSessionWritable(this.prisma, sessionId);
    return this.deployments.start(sessionId, body ?? {});
  }
}

/** 沙箱文件编辑控制器：签发前端直连沙箱所需的短期访问能力 */
@Controller("sessions")
export class HubSandboxController {
  constructor(
    @Inject(SandboxService)
    private readonly sandbox: SandboxService,
  ) {}

  /** 列出当前会话可编辑 Agent 及其沙箱分支 */
  @Get(":sessionId/sandbox/agents")
  listSandboxAgents(@Param("sessionId") sessionId: string) {
    return this.sandbox.listAgents(sessionId);
  }

  /** 签发某个 Agent 分支的短期沙箱连接信息 */
  @Post(":sessionId/sandbox/connect")
  connectSandbox(@Param("sessionId") sessionId: string, @Body() body: SandboxConnectRequest) {
    const agentId = Number(body?.agentId);
    if (!Number.isInteger(agentId)) throw new BadRequestException("AGENT_ID_INVALID");
    return this.sandbox.connect(sessionId, agentId);
  }
}

/** Agent 控制器：管理 Agent 实例的 CRUD、prompt 和下游配置 */
@Controller("agents")
export class HubAgentController {
  constructor(
    @Inject(AgentRegistryService) private readonly agents: AgentRegistryService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HubRealtimeGateway) private readonly gateway: HubRealtimeGateway,
    @Inject(DownstreamOrchestratorService) private readonly downstream: DownstreamOrchestratorService,
  ) {}

  /** 列出所有 Agent */
  @Get()
  listAgents() {
    return this.agents.listAgents().then((items) => ({ items }));
  }

  /** 获取 Agent 详情（含模板和下游配置） */
  @Get(":id/detail")
  async getAgentDetail(@Param("id") id: string) {
    const agentId = Number(id);
    const [agent, config] = await Promise.all([
      this.agents.getAgent(agentId),
      this.agents.getDownstreamConfig(agentId),
    ]);
    if (!agent || !config) {
      throw Object.assign(new Error("Agent not found"), { statusCode: 404 });
    }
    return { agent, template: agent.template ?? null, config };
  }

  /** 从模板创建 Agent 并加入会话 */
  @Post()
  async createAgent(@Body() body: CreateSessionAgentRequest) {
    await assertSessionWritable(this.prisma, body.sessionId);
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
    this.downstream.notifyMemberAdded(body.sessionId, {
      agentId: agent.id,
      description: agent.description || agent.template?.description || "",
    });
    return agent;
  }

  /** 获取 Agent 的 system prompt */
  @Get(":id/prompt")
  async getAgentPrompt(@Param("id") id: string) {
    return this.agents.getAgentPrompt(Number(id));
  }

  /** 更新 Agent 字段 */
  @Patch(":id")
  async updateAgent(@Param("id") id: string, @Body() body: UpdateAgentRequest) {
    await assertAgentSessionsWritable(this.prisma, Number(id));
    return this.agents.updateAgent(Number(id), body);
  }

  /** 删除 Agent：校验权限后软删除 */
  @Delete(":id")
  async deleteAgent(@Param("id") id: string) {
    const agentId = Number(id);
    const agent = await this.agents.getAgent(agentId);
    if (!agent) {
      throw Object.assign(new Error("Agent not found"), { statusCode: 404 });
    }
    const links = await this.prisma.sessionAgent.findMany({ where: { agentId } });
    for (const link of links) {
      await assertSessionWritable(this.prisma, link.sessionId);
    }
    await this.agents.deleteAgent(agentId);
    for (const link of links) {
      const session = await this.prisma.session.findUnique({
        where: { id: link.sessionId },
        include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      if (session) this.gateway.emitSession(mapSession(session));
      this.downstream.notifyMemberDeleted(link.sessionId, { agentId });
    }
    return { ok: true };
  }
}

/** 项目控制器：管理项目的 CRUD */
@Controller("projects")
export class ProjectController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 列出活跃项目 */
  @Get()
  async listProjects() {
    const items = await this.prisma.project.findMany({
      where: { status: "active" },
      orderBy: { updatedAt: "desc" },
    });
    return { items: items.map(mapProject) };
  }

  /** 创建项目 */
  @Post()
  async createProject(@Body() body: CreateProjectRequest) {
    const name = body?.name?.trim();
    const githubUrl = body?.githubUrl?.trim();
    if (!name || !githubUrl) throw new BadRequestException("PROJECT_NAME_AND_GITHUB_URL_REQUIRED");
    const project = await this.prisma.project.create({
      data: {
        name,
        githubUrl,
        defaultBranch: body.defaultBranch?.trim() || "main",
      },
    });
    return mapProject(project);
  }

  /** 更新项目字段 */
  @Patch(":projectId")
  async updateProject(@Param("projectId") projectId: string, @Body() body: UpdateProjectRequest) {
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.githubUrl !== undefined ? { githubUrl: body.githubUrl.trim() } : {}),
        ...(body.defaultBranch !== undefined ? { defaultBranch: body.defaultBranch.trim() || "main" } : {}),
      },
    });
    return mapProject(project);
  }

  /** 软删除项目 */
  @Delete(":projectId")
  async deleteProject(@Param("projectId") projectId: string) {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { status: "deleted" },
    });
    return { ok: true };
  }
}

/** 产物控制器：获取产物内容和版本列表 */
@Controller("artifacts")
export class HubArtifactController {
  constructor(@Inject(ArtifactStorageService) private readonly artifacts: ArtifactStorageService) {}

  /** 获取产物内容：内联返回或 OSS 重定向 */
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

  /** 列出产物版本历史 */
  @Get(":artifactId/versions")
  async listArtifactVersions(@Param("artifactId") artifactId: string) {
    return { items: await this.artifacts.listVersions(artifactId) };
  }
}

/** 上传控制器：处理文件上传和获取上传内容 */
@Controller()
export class HubUploadController {
  constructor(
    @Inject(ArtifactStorageService) private readonly artifacts: ArtifactStorageService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** 上传附件到会话（最大 50MB） */
  @Post("sessions/:sessionId/uploads")
  async uploadAttachment(@Param("sessionId") sessionId: string, @Req() request: Request) {
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (!sessionId) throw new BadRequestException("SESSION_ID_REQUIRED");
    await assertSessionActive(this.prisma, sessionId);
    if (contentLength > MAX_UPLOAD_BYTES) throw new BadRequestException("UPLOAD_TOO_LARGE");
    const data = await readRequestBuffer(request, MAX_UPLOAD_BYTES);
    if (data.length === 0) throw new BadRequestException("UPLOAD_EMPTY");
    const name = decodeHeaderValue(headerString(request.headers["x-file-name"]) ?? "attachment");
    const mimeType = headerString(request.headers["content-type"]) ?? "application/octet-stream";
    return this.artifacts.createAttachment({ sessionId, name, mimeType, data });
  }

  /** 获取上传内容（公开访问） */
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

/** 沙箱回调控制器：保存成功后回流 AgentHub 生成 file.change */
@PublicRoute()
@Controller("sandbox")
export class SandboxCallbackController {
  constructor(
    @Inject(SandboxService)
    private readonly sandbox: SandboxService,
  ) {}

  /** 接收沙箱文件变更回调 */
  @Post("file-changes")
  recordFileChange(@Body() body: SandboxFileChangeCallbackRequest, @Req() request: Request) {
    return this.sandbox.recordFileChangeFromSandbox(
      body,
      headerString(request.headers.authorization),
      headerString(request.headers["x-agenthub-sandbox-secret"]),
    );
  }
}

/** 下游配置控制器：公开 API，供下游 Agent 查询配置 */
@PublicRoute()
@Controller("downstream")
export class DownstreamController {
  constructor(@Inject(AgentRegistryService) private readonly agents: AgentRegistryService) {}

  /** 获取下游 Agent 配置 */
  @Get("agents/:agentId/config")
  async getAgentConfig(@Param("agentId") agentId: string) {
    if (!/^\d+$/.test(agentId)) throw new BadRequestException("AGENT_ID_INVALID");
    const config = await this.agents.getDownstreamConfig(Number(agentId));
    if (!config) throw new NotFoundException("AGENT_NOT_FOUND");
    return config;
  }
}

/** 健康检查控制器（公开） */
@PublicRoute()
@Controller("health")
export class HubHealthController {
  /** 返回服务健康状态 */
  @Get()
  health() {
    return { ok: true, service: "agenthub-backend", ts: new Date().toISOString() };
  }
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ACTIVE_RUN_STATUSES = ["queued", "context_building", "connecting", "running"] as const;

/** 断言会话可写：活跃且无活跃 run */
export async function assertSessionWritable(prisma: PrismaService, sessionId: string) {
  await assertSessionActive(prisma, sessionId);
  await assertSessionHasNoActiveRun(prisma, sessionId);
}

/** 断言会话存在且处于活跃状态 */
export async function assertSessionActive(prisma: PrismaService, sessionId: string) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { status: true },
  });
  if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
  if (session.status !== "active") throw new BadRequestException("SESSION_NOT_ACTIVE");
}

async function assertAgentSessionsWritable(prisma: PrismaService, agentId: number) {
  const links = await prisma.sessionAgent.findMany({
    where: { agentId },
    select: { sessionId: true },
  });
  for (const link of links) {
    await assertSessionWritable(prisma, link.sessionId);
  }
}

async function assertSessionHasNoActiveRun(prisma: PrismaService, sessionId: string) {
  const activeRun = await prisma.agentRun.findFirst({
    where: {
      sessionId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
    },
    select: { id: true },
  });
  if (activeRun) throw new BadRequestException("SESSION_HAS_ACTIVE_RUN");
}

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
