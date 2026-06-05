import { Controller, Get, Inject, Param } from "@nestjs/common";
import { DownstreamSandboxRegistryService } from "../services/downstream-sandbox-registry.service";

/** 沙箱文件编辑控制器：返回前端直连下游 filesystem Socket.IO 所需的会话映射 */
@Controller("sessions")
export class HubSandboxController {
  constructor(
    @Inject(DownstreamSandboxRegistryService)
    private readonly sandbox: DownstreamSandboxRegistryService,
  ) {}

  /** 返回 main 文件视图的直连信息，sessionId 为下游 sessionId */
  @Get(":sessionId/sandbox/filesystem")
  connectFilesystem(@Param("sessionId") sessionId: string) {
    return this.sandbox.getFilesystemConnection(sessionId);
  }
}
