import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  AgentId,
  HubFileChangeDto,
  SandboxAgentBranchDto,
  SandboxAgentsResponse,
  SandboxConnectResponse,
  SandboxFileChangeCallbackRequest,
} from "@agenthub/shared";
import { asObject, mapFileChange, mapSession } from "../mappers/hub.mappers";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { HubEventService } from "./event.service";
import { PrismaService } from "./prisma.service";

const ACTIVE_RUN_STATUSES = ["queued", "context_building", "connecting", "running"] as const;
const SANDBOX_TOKEN_TTL_MS = 15 * 60 * 1000;

interface SandboxTokenPayload {
  iss: "agenthub";
  typ: "sandbox";
  sessionId: string;
  projectId: string;
  agentId: AgentId;
  workspaceId: string;
  exp: number;
}

@Injectable()
export class SandboxService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(HubEventService)
    private readonly events: HubEventService,
    @Inject(HubRealtimeGateway)
    private readonly gateway: HubRealtimeGateway,
  ) {}

  /** 返回会话内可编辑 Agent 及沙箱分支说明 */
  async listAgents(sessionId: string): Promise<SandboxAgentsResponse> {
    const session = await this.loadEditableSession(sessionId, { requireNoActiveRun: false });
    const workspaceId = this.workspaceIdForSession(session);
    const configured = Boolean(this.sandboxBaseUrl());
    const branchMap = this.cachedBranchMap(session.metadata);
    const items: SandboxAgentBranchDto[] = session.participants.map((participant) => ({
      agentId: participant.agentId,
      agentName: participant.agent.name,
      branch: configured ? branchMap.get(participant.agentId) ?? defaultAgentBranch(participant.agentId) : null,
      workspaceId,
      status: configured ? "ready" : "unavailable",
      message: configured ? null : "沙箱服务未配置",
    }));

    return { items, sandboxConfigured: configured, workspaceId };
  }

  /** 为前端签发短期沙箱访问 token */
  async connect(sessionId: string, agentId: AgentId): Promise<SandboxConnectResponse> {
    const session = await this.loadEditableSession(sessionId, { requireNoActiveRun: true });
    const baseUrl = this.sandboxBaseUrl();
    if (!baseUrl) throw new ServiceUnavailableException("SANDBOX_NOT_CONFIGURED");
    const tokenSecret = this.tokenSecret();
    if (!tokenSecret) throw new ServiceUnavailableException("SANDBOX_TOKEN_SECRET_NOT_CONFIGURED");

    const participant = session.participants.find((item) => item.agentId === agentId);
    if (!participant) throw new BadRequestException("AGENT_NOT_IN_SESSION");

    const workspaceId = this.workspaceIdForSession(session);
    const branch = this.cachedBranchMap(session.metadata).get(agentId) ?? defaultAgentBranch(agentId);
    const expiresAt = new Date(Date.now() + SANDBOX_TOKEN_TTL_MS);
    const token = this.signToken({
      iss: "agenthub",
      typ: "sandbox",
      sessionId,
      projectId: session.projectId!,
      agentId,
      workspaceId,
      exp: Math.floor(expiresAt.getTime() / 1000),
    });

    await this.cacheSandboxWorkspace(sessionId, session.metadata, workspaceId, agentId, branch);

    return {
      agentId,
      token,
      sandboxBaseUrl: baseUrl,
      workspaceId,
      branch,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** 接收沙箱保存后的文件变更回调，并复用 file.change 管线 */
  async recordFileChangeFromSandbox(
    input: SandboxFileChangeCallbackRequest,
    authorization?: string,
    callbackSecret?: string,
  ): Promise<HubFileChangeDto> {
    const tokenPayload = this.authenticateSandboxCallback(authorization, callbackSecret);
    if (tokenPayload) {
      if (
        tokenPayload.sessionId !== input.sessionId ||
        tokenPayload.agentId !== input.agentId ||
        tokenPayload.workspaceId !== input.workspaceId
      ) {
        throw new ForbiddenException("SANDBOX_TOKEN_SCOPE_MISMATCH");
      }
    }

    const session = await this.loadEditableSession(input.sessionId, { requireNoActiveRun: false });
    const participant = session.participants.find((item) => item.agentId === input.agentId);
    if (!participant) throw new BadRequestException("AGENT_NOT_IN_SESSION");

    const now = new Date();
    const run = await this.prisma.agentRun.create({
      data: {
        sessionId: input.sessionId,
        orchestratorAgentId: input.agentId,
        status: "running",
        startedAt: now,
        usageJson: { source: "sandbox_editor" } as any,
      },
    });

    const fileEvent = await this.events.append({
      sessionId: input.sessionId,
      runId: run.id,
      eventType: "file.change",
      source: "sandbox_editor",
      speakerAgentId: input.agentId,
      payload: {
        path: input.path,
        oldPath: input.oldPath,
        changeType: input.changeType ?? "modified",
        language: input.language,
        before: {
          content: input.beforeContent,
          sha256: input.beforeSha256,
        },
        after: {
          content: input.afterContent,
          sha256: input.afterSha256,
        },
        patch: input.patch,
        stats: input.stats ?? {},
        metadata: {
          ...(input.metadata ?? {}),
          source: "sandbox_editor",
          editorSource: "sandbox_editor",
          agentId: input.agentId,
          branch: input.branch,
          sandboxWorkspaceId: input.workspaceId,
          applyStatus: "applied",
          appliedAt: now.toISOString(),
        },
      },
    });

    await this.events.append({
      sessionId: input.sessionId,
      runId: run.id,
      eventType: "run.completed",
      source: "sandbox_editor",
      speakerAgentId: input.agentId,
      payload: { status: "completed", source: "sandbox_editor" },
    });

    await this.prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "completed", completedAt: now },
    });

    const [change, updatedSession] = await Promise.all([
      this.prisma.fileChange.findFirst({
        where: { producingEventId: fileEvent.id },
      }),
      this.prisma.session.update({
        where: { id: input.sessionId },
        data: { updatedAt: now },
        include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
      }),
      this.cacheSandboxWorkspace(input.sessionId, session.metadata, input.workspaceId, input.agentId, input.branch),
    ]);
    this.gateway.emitSession(mapSession(updatedSession));

    if (!change) throw new ServiceUnavailableException("SANDBOX_FILE_CHANGE_NOT_RECORDED");
    return mapFileChange(change);
  }

  private async loadEditableSession(sessionId: string, options: { requireNoActiveRun: boolean }) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        project: true,
        participants: {
          where: { participantRole: { not: "deleted" } },
          include: { agent: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    if (session.status !== "active") throw new BadRequestException("SESSION_NOT_ACTIVE");
    if (!session.projectId || !session.project) throw new BadRequestException("PROJECT_NOT_BOUND");
    if (options.requireNoActiveRun) {
      const activeRun = await this.prisma.agentRun.findFirst({
        where: { sessionId, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true },
      });
      if (activeRun) throw new BadRequestException("SESSION_HAS_ACTIVE_RUN");
    }
    return session;
  }

  private workspaceIdForSession(session: { projectId: string | null; metadata: unknown }) {
    const metadata = asObject(session.metadata);
    const cached = asObject(metadata.sandboxWorkspace);
    const workspaceId = stringValue(cached.workspaceId);
    return workspaceId ?? `project-${session.projectId}`;
  }

  private cachedBranchMap(metadataValue: unknown) {
    const metadata = asObject(metadataValue);
    const cached = asObject(metadata.sandboxWorkspace);
    const branches = asObject(cached.agentBranches);
    const map = new Map<number, string>();
    for (const [key, value] of Object.entries(branches)) {
      const agentId = Number(key);
      if (Number.isInteger(agentId) && typeof value === "string" && value.trim()) {
        map.set(agentId, value.trim());
      }
    }
    return map;
  }

  private async cacheSandboxWorkspace(
    sessionId: string,
    metadataValue: unknown,
    workspaceId: string,
    agentId: AgentId,
    branch: string,
  ) {
    const metadata = asObject(metadataValue);
    const cached = asObject(metadata.sandboxWorkspace);
    const branches = asObject(cached.agentBranches);
    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        metadata: {
          ...metadata,
          sandboxWorkspace: {
            ...cached,
            workspaceId,
            agentBranches: {
              ...branches,
              [agentId]: branch,
            },
            updatedAt: new Date().toISOString(),
          },
        } as any,
      },
    });
  }

  private authenticateSandboxCallback(authorization?: string, callbackSecret?: string) {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    if (bearer) return this.verifyToken(bearer);
    const configuredSecret = process.env.AGENTHUB_SANDBOX_CALLBACK_SECRET?.trim();
    if (configuredSecret && callbackSecret === configuredSecret) return null;
    throw new ForbiddenException("SANDBOX_CALLBACK_UNAUTHORIZED");
  }

  private signToken(payload: SandboxTokenPayload) {
    const secret = this.tokenSecret();
    if (!secret) throw new ServiceUnavailableException("SANDBOX_TOKEN_SECRET_NOT_CONFIGURED");
    const body = base64Url(Buffer.from(JSON.stringify(payload), "utf8"));
    const signature = this.sign(body, secret);
    return `${body}.${signature}`;
  }

  private verifyToken(token: string): SandboxTokenPayload {
    const secret = this.tokenSecret();
    if (!secret) throw new ServiceUnavailableException("SANDBOX_TOKEN_SECRET_NOT_CONFIGURED");
    const [body, signature] = token.split(".");
    if (!body || !signature) throw new ForbiddenException("SANDBOX_TOKEN_INVALID");
    const expected = this.sign(body, secret);
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== signatureBuffer.length || !timingSafeEqual(expectedBuffer, signatureBuffer)) {
      throw new ForbiddenException("SANDBOX_TOKEN_INVALID");
    }
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SandboxTokenPayload;
    if (payload.iss !== "agenthub" || payload.typ !== "sandbox") throw new ForbiddenException("SANDBOX_TOKEN_INVALID");
    if (payload.exp <= Math.floor(Date.now() / 1000)) throw new ForbiddenException("SANDBOX_TOKEN_EXPIRED");
    return payload;
  }

  private sign(body: string, secret: string) {
    return base64Url(createHmac("sha256", secret).update(body).digest());
  }

  private sandboxBaseUrl() {
    return process.env.AGENTHUB_SANDBOX_BASE_URL?.trim().replace(/\/+$/, "") || "";
  }

  private tokenSecret() {
    return process.env.AGENTHUB_SANDBOX_TOKEN_SECRET?.trim() || process.env.AGENTHUB_SANDBOX_CALLBACK_SECRET?.trim() || "";
  }
}

function base64Url(buffer: Buffer) {
  return buffer.toString("base64url");
}

function defaultAgentBranch(agentId: AgentId) {
  return `agent-${agentId}`;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
