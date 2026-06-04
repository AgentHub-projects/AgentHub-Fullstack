import { Body, Controller, Delete, Get, Inject, Logger, Param, Patch, Post } from "@nestjs/common";
import type { CreateSessionAgentRequest, UpdateAgentRequest } from "@agenthub/shared";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { mapSession } from "../mappers/hub.mappers";
import { AgentRegistryService } from "../services/agent-registry.service";
import { DownstreamOrchestratorService } from "../services/downstream-orchestrator.service";
import { PrismaService } from "../services/prisma.service";
import { assertAgentSessionsWritable, assertSessionWritable } from "./controller-guards";

/** Agent 控制器：管理 Agent 实例的 CRUD、prompt 和下游配置 */
@Controller("agents")
export class HubAgentController {
  private readonly logger = new Logger(HubAgentController.name);
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

  /**
   * 获取 Agent 的初始化提示词（下游 Agent 启动时调用此接口获取 system prompt）
   * GET /api/agents/:id/prompt → { agentId, systemPrompt }
   */
  @Get(":id/prompt")
  async getAgentPrompt(@Param("id") id: string) {
    const result = await this.agents.getAgentPrompt(Number(id));
    this.logger.log(`[AgentPrompt] agentId=${id} promptLen=${result.systemPrompt.length}`);
    return result;
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
