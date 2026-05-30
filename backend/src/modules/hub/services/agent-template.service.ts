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

  async list(): Promise<AgentTemplateDto[]> {
    const items = await this.prisma.agentTemplate.findMany({
      orderBy: { createdAt: "asc" },
    });
    return items.map(mapTemplate);
  }

  async get(id: number): Promise<AgentTemplateDto> {
    const item = await this.prisma.agentTemplate.findUnique({ where: { id } });
    if (!item) throw new Error("AgentTemplate not found");
    return mapTemplate(item);
  }

  async create(input: CreateAgentTemplateRequest): Promise<AgentTemplateDto> {
    const item = await this.prisma.agentTemplate.create({
      data: {
        name: input.name,
        description: input.description,
        defaultProvider: input.defaultProvider,
        systemPrompt: input.systemPrompt,
        status: "enabled",
      },
    });
    return mapTemplate(item);
  }

  async update(id: number, input: UpdateAgentTemplateRequest): Promise<AgentTemplateDto> {
    const existing = await this.prisma.agentTemplate.findUnique({ where: { id } });
    if (!existing) throw new Error("AgentTemplate not found");

    const item = await this.prisma.agentTemplate.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.defaultProvider !== undefined && { defaultProvider: input.defaultProvider }),
        ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
      },
    });
    return mapTemplate(item);
  }

  async delete(id: number): Promise<{ ok: boolean }> {
    const existing = await this.prisma.agentTemplate.findUnique({ where: { id } });
    if (!existing) throw new Error("AgentTemplate not found");
    await this.prisma.agentTemplate.delete({ where: { id } });
    return { ok: true };
  }
}
