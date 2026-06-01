import { Body, Controller, Get, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import { PublicRoute } from "../auth/public.decorator";
import {
  AUTH_COOKIE_NAME,
  AUTH_MAX_AGE_MS,
  authCookieValue,
  isAccessKeyConfigured,
  isAccessKeyValid,
  isCookieHeaderAuthenticated,
} from "../auth/auth.utils";

@PublicRoute()
@Controller("auth")
export class AuthController {
  @Get("me")
  me(@Req() request: Request) {
    return {
      authenticated: isCookieHeaderAuthenticated(request.headers.cookie),
      configured: isAccessKeyConfigured(),
    };
  }

  @Post("login")
  login(@Body() body: { accessKey?: string }, @Res({ passthrough: true }) response: Response) {
    if (!isAccessKeyConfigured() || !isAccessKeyValid(body?.accessKey)) {
      throw new UnauthorizedException("ACCESS_KEY_INVALID");
    }

    response.cookie(AUTH_COOKIE_NAME, authCookieValue(), {
      httpOnly: true,
      sameSite: "lax",
      maxAge: AUTH_MAX_AGE_MS,
      path: "/",
    });
    return { authenticated: true };
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(AUTH_COOKIE_NAME, { path: "/" });
    return { authenticated: false };
  }
}
