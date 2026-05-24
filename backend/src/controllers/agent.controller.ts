import { Body, Controller, Delete, Get, Param, Post, Put } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import type { AgentDto, UpdateAgentRequest } from "@agenthub/shared";
import { AgentService } from "../services/agent.service";

@Controller()
export class AgentController {
  constructor(@Inject(AgentService) private readonly agents: AgentService) {}

  @Get("agents")
  listAgents(): { items: AgentDto[] } {
    return this.agents.list();
  }

  @Post("agents")
  createAgent(@Body() body: Omit<AgentDto, "id" | "createdAt">): AgentDto {
    return this.agents.create(body);
  }

  @Get("agents/:id")
  getAgent(@Param("id") id: string): AgentDto {
    return this.agents.get(id);
  }

  @Put("agents/:id")
  updateAgent(@Param("id") id: string, @Body() body: UpdateAgentRequest): AgentDto {
    return this.agents.update(id, body);
  }

  @Delete("agents/:id")
  deleteAgent(@Param("id") id: string): { ok: boolean } {
    return this.agents.delete(id);
  }
}
