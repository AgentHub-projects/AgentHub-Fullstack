import { Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import type { AgentInstanceDto, SandboxFilesystemConnectionResponse } from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import type { DownstreamOrchestratorService } from "./downstream-orchestrator.service";

@Injectable()
export class DownstreamSandboxRegistryService {
  private readonly logger = new Logger(DownstreamSandboxRegistryService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional()
    @Inject("DownstreamOrchestratorService")
    private readonly orchestrator?: DownstreamOrchestratorService,
  ) {}

  /** 记录下游 session/new 或 session/load 返回内容；AgentHub 不保存 sandbox 地址。 */
  async saveFromSessionResult(agenthubSessionId: string, downstreamSessionId: string, result: Record<string, unknown>) {
    this.logger.log(
      `[downstream.session.result] agenthubSessionId=${agenthubSessionId} downstreamSessionId=${downstreamSessionId} result=${safeJson(result)}`,
    );
  }

  /** 前端先用 AgentHub sessionId 查询这里，再用返回的下游 sessionId 直连下游 filesystem。
   *  如果下游 session 过期（用户发消息后 1h 无活动），会触发新的 session/new 刷新。 */
  async getFilesystemConnection(sessionId: string): Promise<SandboxFilesystemConnectionResponse> {
    const session = await this.loadSession(sessionId);
    const dbSessionId = stringValue(session.downstreamSessionId);
    this.logger.log(
      `[filesystem.connect.resolve] agenthubSessionId=${sessionId} dbDownstreamSessionId=${dbSessionId ?? "missing"}`,
    );
    if (!dbSessionId) {
      this.logger.warn(`[filesystem.connect] agenthubSessionId=${sessionId} downstreamSessionId=missing`);
      throw new ServiceUnavailableException("DOWNSTREAM_SESSION_NOT_READY");
    }

    let downstreamSessionId = dbSessionId;
    // 如果 orchestrator 可用，尝试刷新过期 session
    try {
      if (this.orchestrator) {
        const refreshed = await (this.orchestrator as any).refreshFilesystemSession(sessionId);
        if (refreshed) {
          downstreamSessionId = refreshed;
          this.logger.log(`[filesystem.connect.refresh] sessionId=${sessionId} newDownstreamSessionId=${refreshed}`);
        }
      }
    } catch {
      // 刷新失败时继续用旧 sessionId
    }

    const response = { downstreamSessionId: downstreamSessionId! };
    this.logger.log(`[filesystem.connect.response] agenthubSessionId=${sessionId} response=${safeJson(response)}`);
    return response;
  }

  private async loadSession(sessionId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, status: true, downstreamSessionId: true },
    });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    return session;
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
