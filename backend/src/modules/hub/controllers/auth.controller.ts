import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { PublicRoute } from "../auth/public.decorator";
import {
  AUTH_COOKIE_NAME,
  AUTH_MAX_AGE_MS,
} from "../auth/auth.utils";
import { AuthSessionService } from "../auth/auth-session.service";

@PublicRoute()
@Controller("auth")
export class AuthController {
  constructor(private readonly authSessions: AuthSessionService) {}

  @Get("me")
  async me(@Req() request: Request) {
    const user = await this.authSessions.authenticateCookie(request.headers.cookie);
    return {
      authenticated: Boolean(user),
      configured: true,
      user,
    };
  }

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

  @Post("logout")
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.authSessions.logout(request.headers.cookie);
    response.clearCookie(AUTH_COOKIE_NAME, { path: "/" });
    return { authenticated: false };
  }
}
