import { Body, Controller, Delete, Get, Inject, Param, Patch, Post } from "@nestjs/common";
import type {
  AgentTemplateDto,
  CreateAgentTemplateRequest,
  UpdateAgentTemplateRequest,
} from "@agenthub/shared";
import { AgentTemplateService } from "../services/agent-template.service";

/** Agent 模板控制器：管理 Agent 模板的 CRUD */
@Controller("agent-templates")
export class AgentTemplateController {
  constructor(
    @Inject(AgentTemplateService) private readonly templates: AgentTemplateService,
  ) {}

  /** 列出所有模板 */
  @Get()
  listTemplates(): Promise<AgentTemplateDto[]> {
    return this.templates.list();
  }

  /** 获取单个模板 */
  @Get(":id")
  getTemplate(@Param("id") id: string): Promise<AgentTemplateDto> {
    return this.templates.get(Number(id));
  }

  /** 创建新模板 */
  @Post()
  createTemplate(@Body() body: CreateAgentTemplateRequest): Promise<AgentTemplateDto> {
    return this.templates.create(body);
  }

  /** 更新模板字段 */
  @Patch(":id")
  updateTemplate(
    @Param("id") id: string,
    @Body() body: UpdateAgentTemplateRequest,
  ): Promise<AgentTemplateDto> {
    return this.templates.update(Number(id), body);
  }

  /** 软删除模板 */
  @Delete(":id")
  deleteTemplate(@Param("id") id: string): Promise<{ ok: boolean }> {
    return this.templates.delete(Number(id));
  }
}
