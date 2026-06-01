import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_ROUTE } from "./public.decorator";
import { isCookieHeaderAuthenticated } from "./auth.utils";

@Injectable()
export class AgentHubAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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
    if (isCookieHeaderAuthenticated(request.headers?.cookie)) return true;
    throw new UnauthorizedException("AUTH_REQUIRED");
  }
}
