import { Inject, Injectable, OnModuleDestroy, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import type { AuthUserDto, UpdateCurrentUserRequest } from "@agenthub/shared";
import {
  AUTH_MAX_AGE_SECONDS,
  authCookieToken,
  verifyPassword,
} from "./auth.utils";
import { PrismaService } from "../services/prisma.service";

type SessionPayload = AuthUserDto;

/** 认证会话服务：基于 Redis 管理用户登录会话的全生命周期 */
@Injectable()
export class AuthSessionService implements OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    this.redis.on("error", () => undefined);
  }

  /** 模块销毁时断开 Redis 连接 */
  async onModuleDestroy() {
    this.redis.disconnect();
  }

  /** 用户登录：验证凭据后在 Redis 中创建会话，返回 token 和用户信息 */
  async login(username: string, password: string) {
    const normalized = username.trim();
    const user = await this.prisma.user.findUnique({ where: { username: normalized } });
    if (!user || user.status !== "active" || !(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException("USERNAME_OR_PASSWORD_INVALID");
    }

    const token = randomBytes(32).toString("hex");
    const payload = mapAuthUser(user);
    await this.redis.set(sessionKey(token), JSON.stringify(payload), "EX", AUTH_MAX_AGE_SECONDS);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return { token, user: payload };
  }

  /** 用户登出：从 Redis 删除会话 token */
  async logout(cookieHeader: string | string[] | undefined) {
    const token = authCookieToken(cookieHeader);
    if (token) await this.redis.del(sessionKey(token));
  }

  /** 通过 Cookie 认证：解析 token 并从 Redis 获取会话，成功后刷新 TTL */
  async authenticateCookie(cookieHeader: string | string[] | undefined) {
    const token = authCookieToken(cookieHeader);
    if (!token) return null;
    const raw = await this.redis.get(sessionKey(token));
    if (!raw) return null;
    try {
      const payload = JSON.parse(raw) as SessionPayload;
      if (!payload.userId || !payload.username) return null;
      await this.redis.expire(sessionKey(token), AUTH_MAX_AGE_SECONDS);
      return payload;
    } catch {
      return null;
    }
  }

  /** 读取当前用户资料：用于 /auth/me，顺带把旧 Redis payload 刷新为最新资料 */
  async currentUser(cookieHeader: string | string[] | undefined): Promise<AuthUserDto | null> {
    const token = authCookieToken(cookieHeader);
    if (!token) return null;
    const raw = await this.redis.get(sessionKey(token));
    if (!raw) return null;
    let payload: SessionPayload;
    try {
      payload = JSON.parse(raw) as SessionPayload;
    } catch {
      return null;
    }
    if (!payload.userId || !payload.username) return null;
    const user = await this.prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user || user.status !== "active") return null;
    const next = mapAuthUser(user);
    await this.redis.set(sessionKey(token), JSON.stringify(next), "EX", AUTH_MAX_AGE_SECONDS);
    return next;
  }

  /** 更新当前用户展示资料，并同步 Redis 会话 payload */
  async updateCurrentUser(
    cookieHeader: string | string[] | undefined,
    input: UpdateCurrentUserRequest,
  ): Promise<AuthUserDto> {
    const token = authCookieToken(cookieHeader);
    if (!token) throw new UnauthorizedException("AUTH_REQUIRED");
    const current = await this.currentUser(cookieHeader);
    if (!current) throw new UnauthorizedException("AUTH_REQUIRED");
    const updated = await this.prisma.user.update({
      where: { id: current.userId },
      data: {
        ...(input.displayName !== undefined ? { displayName: normalizeDisplayName(input.displayName) } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: normalizeAvatarUrl(input.avatarUrl) } : {}),
      },
    });
    const payload = mapAuthUser(updated);
    await this.redis.set(sessionKey(token), JSON.stringify(payload), "EX", AUTH_MAX_AGE_SECONDS);
    return payload;
  }
}

/** 生成 Redis 会话键名 */
function sessionKey(token: string) {
  return `agenthub:session:${token}`;
}

function mapAuthUser(user: {
  id: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}): AuthUserDto {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}

function normalizeDisplayName(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeAvatarUrl(value: string | null | undefined) {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("data:image/")) return null;
  return trimmed;
}
