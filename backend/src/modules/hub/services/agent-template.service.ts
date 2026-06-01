import { Inject, Injectable } from "@nestjs/common";
import type {
  AgentTemplateDto,
  CreateAgentTemplateRequest,
  UpdateAgentTemplateRequest,
} from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import { mapTemplate } from "../mappers/hub.mappers";

@Injectable()
export class AgentTemplateService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private async loadProviderNames(): Promise<Map<number, string>> {
    const providers = await this.prisma.provider.findMany();
    const map = new Map<number, string>();
    for (const p of providers) {
      map.set(p.id, p.name);
    }
    return map;
  }

  private async resolveProviderId(name: string): Promise<number> {
    const provider = await this.prisma.provider.upsert({
      where: { name },
      create: { name },
      update: {},
    });
    return provider.id;
  }

  async list(): Promise<AgentTemplateDto[]> {
    const [items, providerNames] = await Promise.all([
      this.prisma.agentTemplate.findMany({
        orderBy: { createdAt: "asc" },
      }),
      this.loadProviderNames(),
    ]);
    return items.map((row) => mapTemplate(row, providerNames));
  }

  async get(id: number): Promise<AgentTemplateDto> {
    const [item, providerNames] = await Promise.all([
      this.prisma.agentTemplate.findUnique({ where: { id } }),
      this.loadProviderNames(),
    ]);
    if (!item) throw new Error("AgentTemplate not found");
    return mapTemplate(item, providerNames);
  }

  async create(input: CreateAgentTemplateRequest): Promise<AgentTemplateDto> {
    const providerId = await this.resolveProviderId(input.defaultProvider);
    const tools = normalizeTools(input.tools);
    const item = await this.prisma.agentTemplate.create({
      data: {
        name: input.name,
        description: input.description,
        defaultProviderId: providerId,
        systemPrompt: input.systemPrompt,
        promptConfig: input.tools !== undefined ? { tools } : undefined,
        status: "enabled",
      },
    });
    const providerNames = await this.loadProviderNames();
    return mapTemplate(item, providerNames);
  }

  async update(id: number, input: UpdateAgentTemplateRequest): Promise<AgentTemplateDto> {
    const existing = await this.prisma.agentTemplate.findUnique({ where: { id } });
    if (!existing) throw new Error("AgentTemplate not found");

    let providerId: number | undefined;
    if (input.defaultProvider !== undefined) {
      providerId = await this.resolveProviderId(input.defaultProvider);
    }

    const item = await this.prisma.agentTemplate.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(providerId !== undefined && { defaultProviderId: providerId }),
        ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
        ...(input.tools !== undefined && {
          promptConfig: {
            ...objectValue(existing.promptConfig),
            tools: normalizeTools(input.tools),
          },
        }),
      },
    });
    const providerNames = await this.loadProviderNames();
    return mapTemplate(item, providerNames);
  }

  async delete(id: number): Promise<{ ok: boolean }> {
    const existing = await this.prisma.agentTemplate.findUnique({ where: { id } });
    if (!existing) throw new Error("AgentTemplate not found");
    await this.prisma.agentTemplate.delete({ where: { id } });
    return { ok: true };
  }
}

function normalizeTools(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    .slice(0, 12);
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
