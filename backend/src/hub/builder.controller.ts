import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import type {
  ConfirmBuildRequest,
  ConfirmBuildResponse,
  StartBuildRequest,
  StartBuildResponse,
  SendBuildMessageRequest,
  SendBuildMessageResponse,
  BuildSessionDto,
  BuildMessageDto,
} from "@agenthub/shared";
import { BuilderService } from "./builder.service";

@Controller("agent-templates/build")
export class BuilderController {
  constructor(@Inject(BuilderService) private readonly builder: BuilderService) {}

  @Post("start")
  startBuild(@Body() body: StartBuildRequest): Promise<StartBuildResponse> {
    return this.builder.startBuild(body);
  }

  @Get(":buildId")
  getSession(@Param("buildId") buildId: string): Promise<BuildSessionDto> {
    return this.builder.getSession(buildId);
  }

  @Get(":buildId/messages")
  getMessages(@Param("buildId") buildId: string): Promise<BuildMessageDto[]> {
    return this.builder.getMessages(buildId);
  }

  @Post(":buildId/messages")
  sendMessage(
    @Param("buildId") buildId: string,
    @Body() body: SendBuildMessageRequest,
  ): Promise<SendBuildMessageResponse> {
    return this.builder.sendMessage(buildId, body);
  }

  @Post(":buildId/confirm")
  confirmBuild(
    @Param("buildId") buildId: string,
    @Body() body: ConfirmBuildRequest,
  ): Promise<ConfirmBuildResponse> {
    return this.builder.confirmBuild(buildId, body);
  }
}
