import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@agenthub/shared";

@Controller("health")
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return {
      ok: true,
      service: "@agenthub/backend",
      ts: new Date().toISOString()
    };
  }
}
