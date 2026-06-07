import { Body, Controller, Get, Inject, Patch, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { Request, Response } from "express";
import type { UpdateCurrentUserRequest } from "@agenthub/shared";
import { PublicRoute } from "../auth/public.decorator";
import {
  AUTH_COOKIE_NAME,
  AUTH_MAX_AGE_MS,
} from "../auth/auth.utils";
import { AuthSessionService } from "../auth/auth-session.service";
import { ArtifactStorageService } from "../services/artifact-storage.service";
import { devTimed } from "../utils/downstream-orchestrator.utils";

/** 认证控制器：提供登录/登出/当前用户查询（公开路由） */
@PublicRoute()
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthSessionService) private readonly authSessions: AuthSessionService,
    @Inject(ArtifactStorageService) private readonly artifactStorage: ArtifactStorageService,
  ) {}

  /** 获取当前登录用户信息 */
  @Get("me")
  async me(@Req() request: Request) {
    return devTimed("auth/me", async () => {
      const user = await this.authSessions.authenticateCookie(request.headers.cookie);
      return {
        authenticated: Boolean(user),
        configured: true,
        user,
      };
    });
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

  /** 上传头像：接收 base64 图片，上传 OSS，返回 URL */
  @Post("avatar")
  async uploadAvatar(@Req() request: Request, @Body() body: { avatarBase64: string; mimeType?: string }) {
    const user = await this.authSessions.authenticateCookie(request.headers.cookie);
    if (!user) throw new UnauthorizedException("NOT_AUTHENTICATED");

    const data = Buffer.from(body.avatarBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    const avatarUrl = await this.artifactStorage.uploadAvatar(user.userId, data, body.mimeType ?? "image/png");
    if (!avatarUrl) throw new UnauthorizedException("OSS_UPLOAD_FAILED");

    await this.authSessions.updateCurrentUser(request.headers.cookie, { avatarUrl });
    return { avatarUrl };
  }

  /** 更新当前用户展示资料 */
  @Patch("me")
  async updateMe(@Req() request: Request, @Body() body: UpdateCurrentUserRequest) {
    return this.authSessions.updateCurrentUser(request.headers.cookie, body ?? {});
  }

  /** 登出：清除 Redis 会话和 Cookie */
  @Post("logout")
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.authSessions.logout(request.headers.cookie);
    response.clearCookie(AUTH_COOKIE_NAME, { path: "/" });
    return { authenticated: false };
  }
}
