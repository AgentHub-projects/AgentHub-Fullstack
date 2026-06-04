import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import type { SandboxConnectRequest } from "@agenthub/shared";
import { SandboxService } from "../services/sandbox.service";

/** 沙箱文件编辑控制器：签发前端直连沙箱所需的短期访问能力 */
@Controller("sessions")
export class HubSandboxController {
  constructor(
    @Inject(SandboxService)
    private readonly sandbox: SandboxService,
  ) {}

  /** 列出当前会话可编辑 Agent 及其沙箱分支 */
  @Get(":sessionId/sandbox/agents")
  listSandboxAgents(@Param("sessionId") sessionId: string) {
    return this.sandbox.listAgents(sessionId);
  }

  /** 签发某个 Agent 分支的短期沙箱连接信息 */
  @Post(":sessionId/sandbox/connect")
  connectSandbox(@Param("sessionId") sessionId: string, @Body() body: SandboxConnectRequest) {
    const agentId = Number(body?.agentId);
    if (!Number.isInteger(agentId)) throw new BadRequestException("AGENT_ID_INVALID");
    return this.sandbox.connect(sessionId, agentId);
  }
}
