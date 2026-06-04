import { Body, Controller, Inject, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { SandboxFileChangeCallbackRequest } from "@agenthub/shared";
import { PublicRoute } from "../auth/public.decorator";
import { SandboxService } from "../services/sandbox.service";
import { headerString } from "./request-utils";

/** 沙箱回调控制器：保存成功后回流 AgentHub 生成 file.change */
@PublicRoute()
@Controller("sandbox")
export class SandboxCallbackController {
  constructor(
    @Inject(SandboxService)
    private readonly sandbox: SandboxService,
  ) {}

  /** 接收沙箱文件变更回调 */
  @Post("file-changes")
  recordFileChange(@Body() body: SandboxFileChangeCallbackRequest, @Req() request: Request) {
    return this.sandbox.recordFileChangeFromSandbox(
      body,
      headerString(request.headers.authorization),
      headerString(request.headers["x-agenthub-sandbox-secret"]),
    );
  }
}
