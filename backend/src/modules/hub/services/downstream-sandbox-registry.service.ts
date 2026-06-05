import { Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import Redis from "ioredis";
import type { SandboxFilesystemConnectionResponse } from "@agenthub/shared";
import { PrismaService } from "./prisma.service";

const SANDBOX_MAPPING_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface DownstreamSandboxMapping {
  agenthubSessionId: string;
  downstreamSessionId: string;
  sandboxBaseUrl: string;
  workspaceId: string;
  agentBranches: Record<string, string>;
  updatedAt: string;
}

@Injectable()
export class DownstreamSandboxRegistryService implements OnModuleDestroy {
  private readonly logger = new Logger(DownstreamSandboxRegistryService.name);
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

  /** 从下游 session/new 或 session/load 结果中刷新前端直连沙箱映射 */
  async saveFromSessionResult(agenthubSessionId: string, downstreamSessionId: string, result: Record<string, unknown>) {
    const sandbox = asRecord(result.sandbox);
    const sandboxBaseUrl = stringValue(sandbox.baseUrl)?.replace(/\/+$/, "");
    const workspaceId = stringValue(sandbox.workspaceId);
    if (!sandboxBaseUrl || !workspaceId) {
      await this.redis.del(mappingKey(agenthubSessionId));
      this.logger.warn(
        `[sandbox.mapping.delete] agenthubSessionId=${agenthubSessionId} downstreamSessionId=${downstreamSessionId} reason=missing_sandbox sandboxBaseUrl=${sandboxBaseUrl ?? "missing"} workspaceId=${workspaceId ?? "missing"}`,
      );
      return;
    }

    const mapping: DownstreamSandboxMapping = {
      agenthubSessionId,
      downstreamSessionId,
      sandboxBaseUrl,
      workspaceId,
      agentBranches: stringRecord(sandbox.agentBranches),
      updatedAt: new Date().toISOString(),
    };
    await this.redis.set(mappingKey(agenthubSessionId), JSON.stringify(mapping), "EX", SANDBOX_MAPPING_TTL_SECONDS);
    this.logger.log(
      `[sandbox.mapping.save] agenthubSessionId=${agenthubSessionId} downstreamSessionId=${downstreamSessionId} sandboxBaseUrl=${sandboxBaseUrl} workspaceId=${workspaceId} branchCount=${Object.keys(mapping.agentBranches).length}`,
    );
  }

  async getMapping(sessionId: string): Promise<DownstreamSandboxMapping | null> {
    const raw = await this.redis.get(mappingKey(sessionId));
    if (!raw) return null;
    try {
      const mapping = JSON.parse(raw) as DownstreamSandboxMapping;
      if (!mapping.sandboxBaseUrl || !mapping.workspaceId || !mapping.downstreamSessionId) return null;
      return {
        agenthubSessionId: mapping.agenthubSessionId,
        downstreamSessionId: mapping.downstreamSessionId,
        sandboxBaseUrl: mapping.sandboxBaseUrl.replace(/\/+$/, ""),
        workspaceId: mapping.workspaceId,
        agentBranches: stringRecord(mapping.agentBranches),
        updatedAt: mapping.updatedAt,
      };
    } catch {
      return null;
    }
  }

  /** 返回前端直连 filesystem Socket.IO 所需的下游沙箱信息 */
  async getFilesystemConnection(sessionId: string): Promise<SandboxFilesystemConnectionResponse> {
    const [session, mapping] = await Promise.all([this.loadSession(sessionId), this.getMapping(sessionId)]);
    if (!mapping) {
      this.logger.warn(`[filesystem.connect] agenthubSessionId=${sessionId} sandboxMapping=missing`);
      throw new ServiceUnavailableException("DOWNSTREAM_SANDBOX_NOT_READY");
    }
    void session;
    const branchOptions = uniqueStrings(Object.values(mapping.agentBranches));
    this.logger.log(
      `[filesystem.connect] agenthubSessionId=${sessionId} downstreamSessionId=${mapping.downstreamSessionId} sandboxBaseUrl=${mapping.sandboxBaseUrl} workspaceId=${mapping.workspaceId} branchOptions=${JSON.stringify(branchOptions)}`,
    );

    return {
      sandboxBaseUrl: mapping.sandboxBaseUrl,
      downstreamSessionId: mapping.downstreamSessionId,
      workspaceId: mapping.workspaceId,
      branchOptions,
    };
  }

  private async loadSession(sessionId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        participants: {
          where: { participantRole: { not: "deleted" } },
          include: { agent: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    return session;
  }

}

function mappingKey(sessionId: string) {
  return `agenthub:downstream-sandbox:${sessionId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringRecord(value: unknown) {
  const record = asRecord(value);
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" && item.trim()) output[key] = item.trim();
  }
  return output;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
