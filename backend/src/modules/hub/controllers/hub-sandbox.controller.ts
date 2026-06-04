import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import type { SandboxConnectRequest } from "@agenthub/shared";
import { DownstreamSandboxRegistryService } from "../services/downstream-sandbox-registry.service";

/** 沙箱文件编辑控制器：返回前端直连下游沙箱所需的会话映射 */
@Controller("sessions")
export class HubSandboxController {
  constructor(
    @Inject(DownstreamSandboxRegistryService)
    private readonly sandbox: DownstreamSandboxRegistryService,
  ) {}

  /** 列出当前会话可编辑 Agent 及其下游沙箱分支 */
  @Get(":sessionId/sandbox/agents")
  listSandboxAgents(@Param("sessionId") sessionId: string) {
    return this.sandbox.listAgents(sessionId);
  }

  /** 返回某个 Agent 分支的下游沙箱直连信息 */
  @Post(":sessionId/sandbox/connect")
  connectSandbox(@Param("sessionId") sessionId: string, @Body() body: SandboxConnectRequest) {
    const agentId = Number(body?.agentId);
    if (!Number.isInteger(agentId)) throw new BadRequestException("AGENT_ID_INVALID");
    return this.sandbox.connect(sessionId, agentId);
  }
}
