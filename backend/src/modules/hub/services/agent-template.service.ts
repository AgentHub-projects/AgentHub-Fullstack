import { Inject, Injectable } from "@nestjs/common";
import type {
  AgentTemplateDto,
  CreateAgentTemplateRequest,
  UpdateAgentTemplateRequest,
} from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import { mapTemplate } from "../mappers/hub.mappers";

/** Agent 模板服务：管理模板的 CRUD */
@Injectable()
export class AgentTemplateService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 加载所有 provider 并构建 ID→名称映射 */
  private async loadProviderNames(): Promise<Map<number, string>> {
    const providers = await this.prisma.provider.findMany();
    const map = new Map<number, string>();
    for (const p of providers) {
      map.set(p.id, p.name);
    }
    return map;
  }

  /** 根据 provider 名称查找或创建 provider 记录，返回其 ID */
  private async resolveProviderId(name: string): Promise<number> {
    const provider = await this.prisma.provider.upsert({
      where: { name },
      create: { name },
      update: {},
    });
    return provider.id;
  }

  /** 列出所有未禁用的模板 */
  async list(): Promise<AgentTemplateDto[]> {
    const [items, providerNames] = await Promise.all([
      this.prisma.agentTemplate.findMany({
        where: { status: { not: "disabled" } },
        orderBy: { createdAt: "asc" },
      }),
      this.loadProviderNames(),
    ]);
    return items.map((row) => mapTemplate(row, providerNames));
  }

  /** 获取单个模板详情 */
  async get(id: number): Promise<AgentTemplateDto> {
    const [item, providerNames] = await Promise.all([
      this.prisma.agentTemplate.findUnique({ where: { id } }),
      this.loadProviderNames(),
    ]);
    if (!item) throw new Error("AgentTemplate not found");
    return mapTemplate(item, providerNames);
  }

  /** 创建新的 Agent 模板 */
  async create(input: CreateAgentTemplateRequest): Promise<AgentTemplateDto> {
    const providerId = await this.resolveProviderId(input.defaultProvider);
    const tools = normalizeTools(input.tools);
    const item = await this.prisma.agentTemplate.create({
      data: {
        name: input.name,
        description: input.description,
        defaultProviderId: providerId,
        systemPrompt: input.systemPrompt,
        defaultCapabilities: tools,
        promptConfig: input.tools !== undefined ? { tools } : undefined,
        status: "enabled",
      },
    });
    const providerNames = await this.loadProviderNames();
    return mapTemplate(item, providerNames);
  }

  /** 更新模板字段 */
  async update(id: number, input: UpdateAgentTemplateRequest): Promise<AgentTemplateDto> {
    const existing = await this.prisma.agentTemplate.findUnique({ where: { id } });
    if (!existing) throw new Error("AgentTemplate not found");

    let providerId: number | undefined;
    if (input.defaultProvider !== undefined) {
      providerId = await this.resolveProviderId(input.defaultProvider);
    }
    const tools = input.tools !== undefined ? normalizeTools(input.tools) : undefined;

    const item = await this.prisma.agentTemplate.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(providerId !== undefined && { defaultProviderId: providerId }),
        ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
        ...(tools !== undefined && {
          defaultCapabilities: tools,
          promptConfig: {
            ...objectValue(existing.promptConfig),
            tools,
          },
        }),
      },
    });
    const providerNames = await this.loadProviderNames();
    return mapTemplate(item, providerNames);
  }

  /** 软删除模板：标记为 disabled */
  async delete(id: number): Promise<{ ok: boolean }> {
    const existing = await this.prisma.agentTemplate.findUnique({ where: { id } });
    if (!existing) throw new Error("AgentTemplate not found");
    await this.prisma.agentTemplate.update({ where: { id }, data: { status: "disabled" } });
    return { ok: true };
  }
}

/** 标准化工具列表：去重、trim、最多 12 个 */
function normalizeTools(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    .slice(0, 12);
}

/** 安全转换为 Record 对象 */
function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
