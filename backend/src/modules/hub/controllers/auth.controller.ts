import { Body, Controller, Get, Inject, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { PublicRoute } from "../auth/public.decorator";
import {
  AUTH_COOKIE_NAME,
  AUTH_MAX_AGE_MS,
} from "../auth/auth.utils";
import { AuthSessionService } from "../auth/auth-session.service";

/** 认证控制器：提供登录/登出/当前用户查询（公开路由） */
@PublicRoute()
@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthSessionService) private readonly authSessions: AuthSessionService) {}

  /** 获取当前登录用户信息 */
  @Get("me")
  async me(@Req() request: Request) {
    const user = await this.authSessions.authenticateCookie(request.headers.cookie);
    return {
      authenticated: Boolean(user),
      configured: true,
      user,
    };
  }

  /** 登录：验证凭据后设置 httpOnly Cookie */
  @Post("login")
  async login(
    @Body() body: { username?: string; password?: string },
    @Res({ passthrough: true }) response: Response,
  ) {
    const username = body?.username?.trim();
    const password = body?.password ?? "";
    if (!username || !password) throw new UnauthorizedException("USERNAME_OR_PASSWORD_INVALID");
    const result = await this.authSessions.login(username, password);

    response.cookie(AUTH_COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: AUTH_MAX_AGE_MS,
      path: "/",
    });
    return { authenticated: true, user: result.user };
  }

  /** 登出：清除 Redis 会话和 Cookie */
  @Post("logout")
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.authSessions.logout(request.headers.cookie);
    response.clearCookie(AUTH_COOKIE_NAME, { path: "/" });
    return { authenticated: false };
  }
}
