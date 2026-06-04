import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import Redis from "ioredis";
import type {
  AgentId,
  SandboxAgentBranchDto,
  SandboxAgentsResponse,
  SandboxConnectResponse,
} from "@agenthub/shared";
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
  }

  async getMapping(sessionId: string): Promise<DownstreamSandboxMapping | null> {
    const raw = await this.redis.get(mappingKey(sessionId));
    if (!raw) return null;
    try {
      const mapping = JSON.parse(raw) as DownstreamSandboxMapping;
      if (!mapping.sandboxBaseUrl || !mapping.workspaceId) return null;
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

  /** 返回会话内可编辑 Agent 及其下游沙箱分支说明 */
  async listAgents(sessionId: string): Promise<SandboxAgentsResponse> {
    const [session, mapping] = await Promise.all([this.loadSession(sessionId), this.getMapping(sessionId)]);
    const items: SandboxAgentBranchDto[] = session.participants.map((participant) => {
      const branch = mapping?.agentBranches[String(participant.agentId)] ?? null;
      return {
        agentId: participant.agentId,
        agentName: participant.agent.name,
        branch,
        workspaceId: mapping?.workspaceId ?? null,
        status: mapping && branch ? "ready" : "unavailable",
        message: mapping ? (branch ? null : "下游未返回该 Agent 分支") : "下游沙箱尚未就绪",
      };
    });

    return { items, sandboxConfigured: Boolean(mapping), workspaceId: mapping?.workspaceId ?? null };
  }

  /** 返回前端直连下游沙箱所需的地址和分支信息，不签发 AgentHub token */
  async connect(sessionId: string, agentId: AgentId): Promise<SandboxConnectResponse> {
    const [session, mapping, latestRunId] = await Promise.all([
      this.loadSession(sessionId),
      this.getMapping(sessionId),
      this.findLatestRunId(sessionId),
    ]);
    if (!mapping) throw new ServiceUnavailableException("DOWNSTREAM_SANDBOX_NOT_READY");
    const participant = session.participants.find((item) => item.agentId === agentId);
    if (!participant) throw new BadRequestException("AGENT_NOT_IN_SESSION");
    const branch = mapping.agentBranches[String(agentId)];
    if (!branch) throw new ServiceUnavailableException("DOWNSTREAM_SANDBOX_AGENT_BRANCH_NOT_READY");

    return {
      agentId,
      sandboxBaseUrl: mapping.sandboxBaseUrl,
      workspaceId: mapping.workspaceId,
      branch,
      latestRunId,
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

  private async findLatestRunId(sessionId: string) {
    const run = await this.prisma.agentRun.findFirst({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return run?.id ?? null;
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
