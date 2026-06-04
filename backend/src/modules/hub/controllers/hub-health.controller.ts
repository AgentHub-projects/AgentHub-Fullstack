import { Controller, Get } from "@nestjs/common";
import { PublicRoute } from "../auth/public.decorator";

/** 健康检查控制器（公开） */
@PublicRoute()
@Controller("health")
export class HubHealthController {
  /** 返回服务健康状态 */
  @Get()
  health() {
    return { ok: true, service: "agenthub-backend", ts: new Date().toISOString() };
  }
}
