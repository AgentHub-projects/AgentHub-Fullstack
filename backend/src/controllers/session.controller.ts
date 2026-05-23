import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import type { CancelRunResponse, RunSessionRequest, RunSessionResponse, SessionDto } from "@agenthub/shared";
import { SessionService } from "../services/session.service";

@Controller()
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  @Get("session/current")
  getCurrent(): SessionDto {
    return this.sessions.getCurrentSession();
  }

  @Post("session/run")
  async run(@Body() request: RunSessionRequest): Promise<RunSessionResponse> {
    return this.sessions.run(request);
  }

  @Post("agent-runs/:runId/cancel")
  @HttpCode(200)
  cancel(@Param("runId") runId: string): CancelRunResponse {
    return this.sessions.cancel(runId);
  }

  @Post("session/cancel")
  @HttpCode(200)
  cancelCurrent(): CancelRunResponse {
    return this.sessions.cancelCurrent();
  }
}
