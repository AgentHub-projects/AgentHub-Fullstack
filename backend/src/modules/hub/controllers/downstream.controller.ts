import { BadRequestException, Controller, Get, Inject, NotFoundException, Param } from "@nestjs/common";
import { PublicRoute } from "../auth/public.decorator";
import { AgentRegistryService } from "../services/agent-registry.service";

/** 下游配置控制器：公开 API，供下游 Agent 查询配置 */
@PublicRoute()
@Controller("downstream")
export class DownstreamController {
  constructor(@Inject(AgentRegistryService) private readonly agents: AgentRegistryService) {}

  /** 获取下游 Agent 配置 */
  @Get("agents/:agentId/config")
  async getAgentConfig(@Param("agentId") agentId: string) {
    if (!/^\d+$/.test(agentId)) throw new BadRequestException("AGENT_ID_INVALID");
    const config = await this.agents.getDownstreamConfig(Number(agentId));
    if (!config) throw new NotFoundException("AGENT_NOT_FOUND");
    return config;
  }
}
