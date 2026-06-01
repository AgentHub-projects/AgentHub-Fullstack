import { Inject, Injectable, OnModuleDestroy, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import {
  AUTH_MAX_AGE_SECONDS,
  authCookieToken,
  verifyPassword,
} from "./auth.utils";
import { PrismaService } from "../services/prisma.service";

type SessionPayload = {
  userId: string;
  username: string;
};

@Injectable()
export class AuthSessionService implements OnModuleDestroy {
  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    this.redis.on("error", () => undefined);
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }

  async login(username: string, password: string) {
    const normalized = username.trim();
    const user = await this.prisma.user.findUnique({ where: { username: normalized } });
    if (!user || user.status !== "active" || !(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException("USERNAME_OR_PASSWORD_INVALID");
    }

    const token = randomBytes(32).toString("hex");
    const payload: SessionPayload = { userId: user.id, username: user.username };
    await this.redis.set(sessionKey(token), JSON.stringify(payload), "EX", AUTH_MAX_AGE_SECONDS);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return { token, user: payload };
  }

  async logout(cookieHeader: string | string[] | undefined) {
    const token = authCookieToken(cookieHeader);
    if (token) await this.redis.del(sessionKey(token));
  }

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
}

function sessionKey(token: string) {
  return `agenthub:session:${token}`;
}
