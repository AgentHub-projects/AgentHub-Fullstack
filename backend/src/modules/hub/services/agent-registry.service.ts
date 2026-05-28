import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { AgentInstanceDto, AgentTemplateDto, UpdateAgentRequest } from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import { mapAgent, mapTemplate } from "../mappers/hub.mappers";

const IDS = {
  tplOrchestrator: "00000000-0000-4000-8000-000000000001",
  tplFrontend: "00000000-0000-4000-8000-000000000002",
  tplBackend: "00000000-0000-4000-8000-000000000003",
  tplReviewer: "00000000-0000-4000-8000-000000000004",
  orchestrator: "10000000-0000-4000-8000-000000000001",
  frontend: "10000000-0000-4000-8000-000000000002",
  backend: "10000000-0000-4000-8000-000000000003",
  reviewer: "10000000-0000-4000-8000-000000000004",
};

@Injectable()
export class AgentRegistryService implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedDefaults();
  }

  async listTemplates(): Promise<AgentTemplateDto[]> {
    const items = await this.prisma.agentTemplate.findMany({
      orderBy: { createdAt: "asc" },
    });
    return items.map(mapTemplate);
  }

  async listAgents(): Promise<AgentInstanceDto[]> {
    const items = await this.prisma.agent.findMany({
      include: { template: true },
      orderBy: [{ isDefaultOrchestrator: "desc" }, { createdAt: "asc" }],
    });
    return items.map(mapAgent);
  }

  async getAgent(id: string): Promise<AgentInstanceDto | null> {
    const item = await this.prisma.agent.findUnique({
      where: { id },
      include: { template: true },
    });
    return item ? mapAgent(item) : null;
  }

  async getAgents(ids: string[]): Promise<AgentInstanceDto[]> {
    if (ids.length === 0) return [];
    const items = await this.prisma.agent.findMany({
      where: { id: { in: ids } },
      include: { template: true },
    });
    return items.map(mapAgent);
  }

  async createAgentFromTemplate(
    sessionId: string,
    templateId: string,
    provider: number,
    name: string,
  ): Promise<AgentInstanceDto> {
    const tpl = await this.prisma.agentTemplate.findUnique({
      where: { id: templateId },
    });
    if (!tpl) throw new Error("Template not found");

    const agent = await this.prisma.agent.create({
      data: {
        templateId: tpl.id,
        name,
        description: tpl.description,
        provider,
        status: "enabled",
      },
      include: { template: true },
    });

    await this.prisma.sessionAgent.create({
      data: {
        sessionId,
        agentId: agent.id,
        participantRole: "member",
        source: "manual_add",
        firstMentionedAt: new Date(),
        lastActiveAt: new Date(),
      },
    });

    return mapAgent(agent);
  }

  async updateAgent(id: string, input: UpdateAgentRequest): Promise<AgentInstanceDto> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new Error("Agent not found");

    const updated = await this.prisma.agent.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
      },
      include: { template: true },
    });

    return mapAgent(updated);
  }

  async deleteAgent(id: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new Error("Agent not found");

    // Cascade delete handles SessionAgent cleanup
    await this.prisma.agent.delete({ where: { id } });
  }

  async getDefaultOrchestrator(): Promise<AgentInstanceDto> {
    let agent = await this.prisma.agent.findFirst({
      where: { isDefaultOrchestrator: true },
      include: { template: true },
    });
    if (!agent) {
      await this.seedDefaults();
      agent = await this.prisma.agent.findFirst({
        where: { isDefaultOrchestrator: true },
        include: { template: true },
      });
    }
    if (!agent) {
      throw new Error("Default orchestrator agent is not configured");
    }
    return mapAgent(agent);
  }

  private async seedDefaults() {
    await this.prisma.agentTemplate.upsert({
      where: { id: IDS.tplOrchestrator },
      create: {
        id: IDS.tplOrchestrator,
        name: "主 Orchestrator 模板",
        description: "负责理解用户目标、协调被 @ 的 Agent，并按群聊方式回传产出。",
        defaultProvider: 0,
        systemPrompt: "你是 AgentHub 的主协调 Agent。你只需要调度下游 worker，并持续上报 speaker、artifact 与文件变更事件。",
        defaultCapabilities: ["orchestrate", "stream", "file_change", "artifact"],
        defaultModelConfig: { provider: "openai-compatible" },
        status: "enabled",
      },
      update: {
        status: "enabled",
      },
    });

    await this.prisma.agentTemplate.upsert({
      where: { id: IDS.tplFrontend },
      create: {
        id: IDS.tplFrontend,
        name: "Frontend Agent 模板",
        description: "负责前端 UI、状态管理、实时渲染和用户体验。",
        defaultProvider: 0,
        systemPrompt: "你负责前端实现，输出需要携带 speaker=frontend agentId。",
        defaultCapabilities: ["frontend", "react", "diff", "artifact"],
        defaultModelConfig: { provider: "openai-compatible" },
        status: "enabled",
      },
      update: { status: "enabled" },
    });

    await this.prisma.agentTemplate.upsert({
      where: { id: IDS.tplBackend },
      create: {
        id: IDS.tplBackend,
        name: "Backend Agent 模板",
        description: "负责后端 API、数据库、WebSocket、OSS 与上下文维护。",
        defaultProvider: 1,
        systemPrompt: "你负责后端实现，输出需要携带 speaker=backend agentId。",
        defaultCapabilities: ["backend", "postgresql", "websocket", "oss"],
        defaultModelConfig: { provider: "openai-compatible" },
        status: "enabled",
      },
      update: { status: "enabled" },
    });

    await this.prisma.agentTemplate.upsert({
      where: { id: IDS.tplReviewer },
      create: {
        id: IDS.tplReviewer,
        name: "Review Agent 模板",
        description: "负责验收、回归风险、文档一致性和质量反馈。",
        defaultProvider: 1,
        systemPrompt: "你负责审查实现是否满足 AgentHub 设计文档。",
        defaultCapabilities: ["review", "test", "acceptance"],
        defaultModelConfig: { provider: "openai-compatible" },
        status: "enabled",
      },
      update: { status: "enabled" },
    });

    await this.prisma.agent.upsert({
      where: { id: IDS.orchestrator },
      create: {
        id: IDS.orchestrator,
        templateId: IDS.tplOrchestrator,
        name: "main-orchestrator",
        description: "会话级长连接入口。用户 @ 多个 Agent 时也先进入该 Agent。",
        provider: 0, // claude-code
        isDefaultOrchestrator: true,
        status: "offline",
      },
      update: {
        isDefaultOrchestrator: true,
      },
    });

    await this.prisma.agent.upsert({
      where: { id: IDS.frontend },
      create: {
        id: IDS.frontend,
        templateId: IDS.tplFrontend,
        name: "frontend-agent",
        description: "群聊成员：前端实现。",
        provider: 0, // claude-code
        status: "enabled",
      },
      update: { status: "enabled" },
    });

    await this.prisma.agent.upsert({
      where: { id: IDS.backend },
      create: {
        id: IDS.backend,
        templateId: IDS.tplBackend,
        name: "backend-agent",
        description: "群聊成员：后端实现。",
        provider: 1, // codex
        status: "enabled",
      },
      update: { status: "enabled" },
    });

    await this.prisma.agent.upsert({
      where: { id: IDS.reviewer },
      create: {
        id: IDS.reviewer,
        templateId: IDS.tplReviewer,
        name: "review-agent",
        description: "群聊成员：验收与审查。",
        provider: 1, // codex
        status: "enabled",
      },
      update: { status: "enabled" },
    });
  }
}
