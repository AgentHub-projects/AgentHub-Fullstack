import "reflect-metadata";
import { UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { AgentHubAuthGuard } from "../src/modules/hub/auth/auth.guard";
import { AuthSessionService } from "../src/modules/hub/auth/auth-session.service";
import { IS_PUBLIC_ROUTE } from "../src/modules/hub/auth/public.decorator";

describe("AgentHubAuthGuard", () => {
  it("declares explicit injection tokens for tsx runtime", () => {
    expect(injectedTokens(AgentHubAuthGuard)).toEqual(expect.arrayContaining([
      { index: 0, param: Reflector },
      { index: 1, param: AuthSessionService },
    ]));
  });

  it("allows public routes before checking cookies", async () => {
    const reflector = { getAllAndOverride: vi.fn(() => true) };
    const authSessions = { authenticateCookie: vi.fn() };
    const guard = new AgentHubAuthGuard(reflector as any, authSessions as any);

    await expect(guard.canActivate(httpContext({ path: "/api/auth/me" }) as any)).resolves.toBe(true);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_ROUTE, [expect.any(Function), expect.any(Function)]);
    expect(authSessions.authenticateCookie).not.toHaveBeenCalled();
  });

  it("allows authenticated http requests", async () => {
    const guard = new AgentHubAuthGuard(
      { getAllAndOverride: vi.fn(() => false) } as any,
      { authenticateCookie: vi.fn(async () => ({ userId: "user-1", username: "admin" })) } as any,
    );

    await expect(guard.canActivate(httpContext({ cookie: "agenthub_session=token" }) as any)).resolves.toBe(true);
  });

  it("rejects unauthenticated http requests", async () => {
    const guard = new AgentHubAuthGuard(
      { getAllAndOverride: vi.fn(() => false) } as any,
      { authenticateCookie: vi.fn(async () => null) } as any,
    );

    await expect(guard.canActivate(httpContext({}) as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

function injectedTokens(target: any) {
  return Reflect.getMetadata("self:paramtypes", target);
}

function httpContext(input: { path?: string; cookie?: string }) {
  return {
    getHandler: () => function handler() {},
    getClass: () => function Controller() {},
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () => ({
        path: input.path,
        headers: { cookie: input.cookie },
      }),
    }),
  };
}
