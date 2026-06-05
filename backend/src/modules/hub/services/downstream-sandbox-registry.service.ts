import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { SandboxFilesystemConnectionResponse } from "@agenthub/shared";
import { PrismaService } from "./prisma.service";

@Injectable()
export class DownstreamSandboxRegistryService {
  private readonly logger = new Logger(DownstreamSandboxRegistryService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 记录下游 session/new 返回内容；AgentHub 不保存 sandbox 地址。 */
  async saveFromSessionResult(agenthubSessionId: string, downstreamSessionId: string, result: Record<string, unknown>) {
    this.logger.log(
      `[downstream.session.result] agenthubSessionId=${agenthubSessionId} downstreamSessionId=${downstreamSessionId} result=${safeJson(result)}`,
    );
  }

  /** 前端用 AgentHub sessionId 查询下游 sessionId，再直连下游 filesystem */
  async getFilesystemConnection(sessionId: string): Promise<SandboxFilesystemConnectionResponse> {
    const session = await this.loadSession(sessionId);
    const downstreamSessionId = stringValue(session.downstreamSessionId);
    this.logger.log(
      `[filesystem.connect.resolve] agenthubSessionId=${sessionId} dbDownstreamSessionId=${downstreamSessionId ?? "missing"}`,
    );
    if (!downstreamSessionId) {
      this.logger.warn(`[filesystem.connect] agenthubSessionId=${sessionId} downstreamSessionId=missing`);
      throw new ServiceUnavailableException("DOWNSTREAM_SESSION_NOT_READY");
    }

    const response = { downstreamSessionId };
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
