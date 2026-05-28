import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import type {
  AgentTemplateDto,
  CreateAgentTemplateRequest,
  UpdateAgentTemplateRequest,
} from "@agenthub/shared";
import { AgentTemplateService } from "./agent-template.service";

@Controller("agent-templates")
export class AgentTemplateController {
  constructor(
    @Inject(AgentTemplateService) private readonly templates: AgentTemplateService,
  ) {}

  @Get()
  listTemplates(): Promise<AgentTemplateDto[]> {
    return this.templates.list();
  }

  @Get(":id")
  getTemplate(@Param("id") id: string): Promise<AgentTemplateDto> {
    return this.templates.get(id);
  }

  @Post()
  createTemplate(@Body() body: CreateAgentTemplateRequest): Promise<AgentTemplateDto> {
    return this.templates.create(body);
  }

  @Patch(":id")
  updateTemplate(
    @Param("id") id: string,
    @Body() body: UpdateAgentTemplateRequest,
  ): Promise<AgentTemplateDto> {
    return this.templates.update(id, body);
  }

  @Delete(":id")
  deleteTemplate(@Param("id") id: string): Promise<{ ok: boolean }> {
    return this.templates.delete(id);
  }
}
