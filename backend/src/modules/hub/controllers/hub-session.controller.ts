import {
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
} from "@nestjs/common";
import type {
  AddParticipantRequest,
  CreateHubSessionRequest,
  PinHubMessageRequest,
  SendHubMessageRequest,
  StartDeploymentRequest,
  UpdateHubSessionRequest,
} from "@agenthub/shared";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { mapArtifact, mapEvent, mapFileChange, mapSession } from "../mappers/hub.mappers";
import { DeploymentService } from "../services/deployment.service";
import { HubSessionService } from "../services/hub-session.service";
import { PrismaService } from "../services/prisma.service";
import { assertSessionActive, assertSessionWritable } from "./controller-guards";
import { devTimed } from "../utils/downstream-orchestrator.utils";

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
  listSessions(
    @Query("q") query?: string,
    @Query("includeArchived") includeArchived?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ) {
    return devTimed("sessions list", () =>
      this.sessions.listSessions({
        query,
        includeArchived: includeArchived === "true",
        limit: Number(limit),
        cursor,
      }),
    );
  }

  /** 创建会话 */
  @Post()
  createSession(@Body() body: CreateHubSessionRequest) {
    return this.sessions.createSession(body ?? {});
  }

  /** 获取会话详情 */
  @Get(":sessionId")
  getSession(@Param("sessionId") sessionId: string, @Query("messageLimit") messageLimit?: string) {
    return devTimed("session detail", () => this.sessions.getDetail(sessionId, { messageLimit: Number(messageLimit) }));
  }

  /** 分页加载会话时间线 */
  @Get(":sessionId/timeline")
  listTimeline(
    @Param("sessionId") sessionId: string,
    @Query("limit") limit?: string,
    @Query("before") before?: string,
  ) {
    return devTimed("timeline", () => this.sessions.listTimeline(sessionId, { limit: Number(limit), before }));
  }

  /** 按需加载关键消息 */
  @Get(":sessionId/pinned-messages")
  listPinnedMessages(@Param("sessionId") sessionId: string, @Query("limit") limit?: string) {
    return this.sessions.listPinnedMessages(sessionId, { limit: Number(limit) });
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
    return devTimed("session artifacts", async () => {
      const items = await this.prisma.artifact.findMany({
        where: { sessionId },
        orderBy: { updatedAt: "desc" },
      });
      return { items: items.map(mapArtifact) };
    });
  }

  /** 列出文件变更 */
  @Get(":sessionId/file-changes")
  async listFileChanges(@Param("sessionId") sessionId: string) {
    return devTimed("session file-changes", async () => {
      const items = await this.prisma.fileChange.findMany({
        where: { sessionId },
        orderBy: { createdAt: "desc" },
      });
      return { items: items.map(mapFileChange) };
    });
  }

  /** 应用文件变更 */
  @Post(":sessionId/file-changes/:fileChangeId/apply")
  applyFileChange(@Param("sessionId") sessionId: string, @Param("fileChangeId") fileChangeId: string) {
    return this.sessions.applyFileChange(sessionId, fileChangeId);
  }

  /** 部署预检 */
  @Get(":sessionId/deployments/preflight")
  preflightDeployment(@Param("sessionId") sessionId: string) {
    return devTimed("preflight", () => this.deployments.preflight(sessionId));
  }

  /** 启动部署 */
  @Post(":sessionId/deployments")
  async startDeployment(@Param("sessionId") sessionId: string, @Body() body: StartDeploymentRequest) {
    await assertSessionWritable(this.prisma, sessionId);
    return this.deployments.start(sessionId, body ?? {});
  }
}
