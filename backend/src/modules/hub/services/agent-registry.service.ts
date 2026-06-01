import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { AgentInstanceDto, AgentTemplateDto, UpdateAgentRequest } from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import { mapAgent, mapTemplate } from "../mappers/hub.mappers";

const IDS = {
  orchestrator: 1,
  frontend: 2,
  backend: 3,
  reviewer: 4,
};

@Injectable()
export class AgentRegistryService implements OnModuleInit {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedDefaults();
  }

  async resolveProviderId(name: string): Promise<number> {
    const provider = await this.prisma.provider.upsert({
      where: { name },
      create: { name },
      update: {},
    });
    return provider.id;
  }

  private async loadProviderNames(): Promise<Map<number, string>> {
    const providers = await this.prisma.provider.findMany();
    const map = new Map<number, string>();
    for (const p of providers) {
      map.set(p.id, p.name);
    }
    return map;
  }

  async listTemplates(): Promise<AgentTemplateDto[]> {
    const [items, providerNames] = await Promise.all([
      this.prisma.agentTemplate.findMany({
        orderBy: { createdAt: "asc" },
      }),
      this.loadProviderNames(),
    ]);
    return items.map((row) => mapTemplate(row, providerNames));
  }

  async listAgents(): Promise<AgentInstanceDto[]> {
    const [items, providerNames] = await Promise.all([
      this.prisma.agent.findMany({
        include: { template: true },
        orderBy: [{ isDefaultOrchestrator: "desc" }, { createdAt: "asc" }],
      }),
      this.loadProviderNames(),
    ]);
    return items.map((row) => mapAgent(row, providerNames));
  }

  async getAgent(id: number): Promise<AgentInstanceDto | null> {
    const [item, providerNames] = await Promise.all([
      this.prisma.agent.findUnique({
        where: { id },
        include: { template: true },
      }),
      this.loadProviderNames(),
    ]);
    return item ? mapAgent(item, providerNames) : null;
  }

  async getAgents(ids: number[]): Promise<AgentInstanceDto[]> {
    if (ids.length === 0) return [];
    const [items, providerNames] = await Promise.all([
      this.prisma.agent.findMany({
        where: { id: { in: ids } },
        include: { template: true },
      }),
      this.loadProviderNames(),
    ]);
    return items.map((row) => mapAgent(row, providerNames));
  }

  async createAgentFromTemplate(
    sessionId: string,
    templateId: number,
    provider?: string,
    name?: string,
    participantRole = "member",
  ): Promise<AgentInstanceDto> {
    const tpl = await this.prisma.agentTemplate.findUnique({
      where: { id: templateId },
    });
    if (!tpl) throw new Error("Template not found");

    const providerId = provider ? await this.resolveProviderId(provider) : tpl.defaultProviderId;
    const agentName = await this.nextAgentName(name?.trim() || tpl.name);

    const agent = await this.prisma.agent.create({
      data: {
        templateId: tpl.id,
        name: agentName,
        description: tpl.description,
        providerId,
        status: "enabled",
      },
      include: { template: true },
    });

    await this.prisma.sessionAgent.create({
      data: {
        sessionId,
        agentId: agent.id,
        participantRole,
        source: "manual_add",
        firstMentionedAt: new Date(),
        lastActiveAt: new Date(),
      },
    });

    const providerNames = await this.loadProviderNames();
    return mapAgent(agent, providerNames);
  }

  async updateAgent(id: number, input: UpdateAgentRequest): Promise<AgentInstanceDto> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new Error("Agent not found");

    let providerId: number | undefined;
    if (input.provider !== undefined) {
      providerId = await this.resolveProviderId(input.provider);
    }

    const updated = await this.prisma.agent.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(providerId !== undefined ? { providerId } : {}),
      },
      include: { template: true },
    });

    const providerNames = await this.loadProviderNames();
    return mapAgent(updated, providerNames);
  }

  async getAgentPrompt(id: number): Promise<{ agentId: number; systemPrompt: string }> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: { template: true },
    });
    if (!agent) throw new Error("Agent not found");
    return {
      agentId: agent.id,
      systemPrompt: agent.template.systemPrompt,
    };
  }

  async deleteAgent(id: number): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) throw new Error("Agent not found");

    await this.prisma.agent.delete({ where: { id } });
  }

  private async nextAgentName(baseName: string): Promise<string> {
    const base = baseName.trim() || "Agent";
    let candidate = base;
    let index = 2;
    while (await this.prisma.agent.findFirst({ where: { name: candidate }, select: { id: true } })) {
      candidate = `${base} ${index}`;
      index += 1;
    }
    return candidate;
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
    const providerNames = await this.loadProviderNames();
    return mapAgent(agent, providerNames);
  }

  private async seedDefaults() {
    // Ensure provider records exist
    const providerClaudeId = await this.resolveProviderId("claude-code");
    const providerOpenId = await this.resolveProviderId("open-code");

    // Seed templates by name (id is autoincrement)
    const ensureTemplate = async (name: string, data: Record<string, any>) => {
      const existing = await this.prisma.agentTemplate.findFirst({ where: { name } });
      if (existing) return existing;
      return this.prisma.agentTemplate.create({ data: { name, ...data } as any });
    };

    const tplOrchestrator = await ensureTemplate("主 Orchestrator 模板", {
      description: "负责理解用户目标、协调被 @ 的 Agent，并按群聊方式回传产出。",
      defaultProviderId: providerClaudeId,
      systemPrompt: "你是 AgentHub 的主协调 Agent。你只需要调度下游 worker，并持续上报 speaker、artifact 与文件变更事件。",
      defaultCapabilities: ["orchestrate", "stream", "file_change", "artifact"],
      defaultModelConfig: { provider: "openai-compatible" },
      status: "enabled",
    });

    const tplFrontend = await ensureTemplate("Frontend Agent 模板", {
      description: "负责前端 UI、状态管理、实时渲染和用户体验。",
      defaultProviderId: providerClaudeId,
      systemPrompt: "你负责前端实现，输出需要携带 speaker=frontend agentId。",
      defaultCapabilities: ["frontend", "react", "diff", "artifact"],
      defaultModelConfig: { provider: "openai-compatible" },
      status: "enabled",
    });

    const tplBackend = await ensureTemplate("Backend Agent 模板", {
      description: "负责后端 API、数据库、WebSocket、OSS 与上下文维护。",
      defaultProviderId: providerOpenId,
      systemPrompt: "你负责后端实现，输出需要携带 speaker=backend agentId。",
      defaultCapabilities: ["backend", "postgresql", "websocket", "oss"],
      defaultModelConfig: { provider: "openai-compatible" },
      status: "enabled",
    });

    const tplReviewer = await ensureTemplate("Review Agent 模板", {
      description: "负责验收、回归风险、文档一致性和质量反馈。",
      defaultProviderId: providerOpenId,
      systemPrompt: "你负责审查实现是否满足 AgentHub 设计文档。",
      defaultCapabilities: ["review", "test", "acceptance"],
      defaultModelConfig: { provider: "openai-compatible" },
      status: "enabled",
    });

    await this.prisma.agent.upsert({
      where: { id: IDS.orchestrator },
      create: {
        id: IDS.orchestrator,
        templateId: tplOrchestrator.id,
        name: "main-orchestrator",
        description: "会话级长连接入口。用户 @ 多个 Agent 时也先进入该 Agent。",
        providerId: providerClaudeId,
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
        templateId: tplFrontend.id,
        name: "frontend-agent",
        description: "群聊成员：前端实现。",
        providerId: providerClaudeId,
        status: "enabled",
      },
      update: { status: "enabled" },
    });

    await this.prisma.agent.upsert({
      where: { id: IDS.backend },
      create: {
        id: IDS.backend,
        templateId: tplBackend.id,
        name: "backend-agent",
        description: "群聊成员：后端实现。",
        providerId: providerOpenId,
        status: "enabled",
      },
      update: { status: "enabled" },
    });

    await this.prisma.agent.upsert({
      where: { id: IDS.reviewer },
      create: {
        id: IDS.reviewer,
        templateId: tplReviewer.id,
        name: "review-agent",
        description: "群聊成员：验收与审查。",
        providerId: providerOpenId,
        status: "enabled",
      },
      update: { status: "enabled" },
    });
  }
}
