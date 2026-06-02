import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_ROUTE } from "./public.decorator";
import { AuthSessionService } from "./auth-session.service";

/** 全局鉴权守卫：检查 @PublicRoute 标记、下游路由豁免，其余通过 Cookie 认证 */
@Injectable()
export class AgentHubAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(AuthSessionService)
    private readonly authSessions: AuthSessionService,
  ) {}

  /** 判断是否放行：公开路由→放行，非 HTTP→放行，下游路由→放行，已认证→放行，否则 401 */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    if (context.getType() !== "http") return true;

    const request = context.switchToHttp().getRequest<{
      path?: string;
      headers?: { cookie?: string | string[] };
    }>();
    if (request.path?.startsWith("/api/downstream/")) return true;
    if (await this.authSessions.authenticateCookie(request.headers?.cookie)) return true;
    throw new UnauthorizedException("AUTH_REQUIRED");
  }
}
