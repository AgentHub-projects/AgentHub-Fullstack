import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { DeploymentPreflightResponse, StartDeploymentRequest } from "@agenthub/shared";
import { mapDeployment, mapMessage, mapSession, asObject } from "../mappers/hub.mappers";
import { PrismaService } from "./prisma.service";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";

const POLL_INTERVAL_MS = 3000;
const DEPLOY_TIMEOUT_MS = 30 * 60 * 1000;
const VERCEL_API_BASE_URL = "https://api.vercel.com";
const VERCEL_TARGET = "production";

@Injectable()
export class DeploymentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HubRealtimeGateway) private readonly gateway: HubRealtimeGateway,
  ) {}

  async preflight(sessionId: string): Promise<DeploymentPreflightResponse> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: true },
    });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");

    const metadata = asObject(session.metadata);
    const commitSha = stringValue(metadata.latestSuccessfulPushCommitSha) ?? null;
    const projectBound = Boolean(session.projectId && session.project);
    const projectMetadata = asObject(session.project?.metadata);
    const vercelConfigured = Boolean(process.env.VERCEL_TOKEN?.trim());
    const vercelProjectBound = Boolean(stringValue(projectMetadata.vercelProjectId));
    const githubRepo = session.project ? parseGithubRepository(session.project.githubUrl) : null;
    const missing: string[] = [];
    if (!projectBound) missing.push("project");
    if (!commitSha) missing.push("commit");
    if (!vercelConfigured) missing.push("vercel_token");
    if (projectBound && !githubRepo) missing.push("github_repository");

    return {
      canDeploy: projectBound && Boolean(commitSha) && vercelConfigured && Boolean(githubRepo),
      missing,
      projectBound,
      latestSuccessfulPushCommitSha: commitSha,
      vercelConfigured,
      vercelProjectBound,
    };
  }

  async start(sessionId: string, _input: StartDeploymentRequest = {}) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: true, runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!session || session.status === "deleted") throw new NotFoundException("SESSION_NOT_FOUND");
    if (session.status !== "active") throw new BadRequestException("SESSION_NOT_ACTIVE");
    if (!session.projectId || !session.project) throw new BadRequestException("PROJECT_NOT_BOUND");
    if (!process.env.VERCEL_TOKEN?.trim()) throw new BadRequestException("VERCEL_TOKEN_NOT_CONFIGURED");
    const githubRepo = parseGithubRepository(session.project.githubUrl);
    if (!githubRepo) throw new BadRequestException("GITHUB_REPOSITORY_UNSUPPORTED");

    const metadata = asObject(session.metadata);
    const commitSha = stringValue(metadata.latestSuccessfulPushCommitSha);
    if (!commitSha) throw new BadRequestException("NO_SUCCESSFUL_PUSH_COMMIT");
    const initialTitle = deploymentStatusText("queued");

    const message = await this.prisma.message.create({
      data: {
        sessionId,
        role: "system",
        contentText: `${initialTitle}：${session.project.name}@${commitSha.slice(0, 12)}`,
        contentJson: {
          parts: [
            {
              id: "deploy_status",
              type: "deploy_status",
              title: initialTitle,
              metadata: {
                provider: "vercel",
                projectId: session.projectId,
                projectName: session.project.name,
                commitSha,
                status: "queued",
                target: VERCEL_TARGET,
                targetLabel: "Vercel Production",
              },
            },
          ],
        } as any,
      },
    });

    const projectMetadata = asObject(session.project.metadata);
    const deployment = await this.prisma.deployment.create({
      data: {
        sessionId,
        projectId: session.projectId,
        triggerMessageId: message.id,
        commitSha,
        status: "queued",
        metadata: {
          provider: "vercel",
          target: VERCEL_TARGET,
          githubOwner: githubRepo.owner,
          githubRepo: githubRepo.repo,
          vercelProjectId: stringValue(projectMetadata.vercelProjectId),
          vercelProjectName: stringValue(projectMetadata.vercelProjectName),
          vercelTeamId: process.env.VERCEL_TEAM_ID?.trim() || null,
        } as any,
      },
    });
    const syncedMessage = await this.syncDeploymentMessage(deployment.id);
    const updatedSession = await this.prisma.session.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    this.gateway.emitSession(mapSession(updatedSession));
    void this.runDeployJob(deployment.id);
    return { deployment: mapDeployment(deployment), message: syncedMessage ?? mapMessage(message) };
  }

  private async runDeployJob(deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true },
    });
    if (!deployment) return;

    const githubRepo = parseGithubRepository(deployment.project.githubUrl);
    if (!githubRepo) {
      await this.markFailed(deploymentId, "GITHUB_REPOSITORY_UNSUPPORTED");
      return;
    }

    try {
      const vercelProject = await this.ensureVercelProject(deployment.project, githubRepo);
      const createPayload = await vercelRequest("/v13/deployments", {
        method: "POST",
        body: JSON.stringify({
          name: vercelProject.name,
          project: vercelProject.id,
          target: VERCEL_TARGET,
          gitSource: {
            type: "github",
            org: githubRepo.owner,
            repo: githubRepo.repo,
            ref: deployment.project.defaultBranch || "main",
            sha: deployment.commitSha,
          },
          meta: {
            agenthubDeploymentId: deployment.id,
            agenthubSessionId: deployment.sessionId,
            githubCommitSha: deployment.commitSha,
          },
        }),
      });
      const vercelDeploymentId = stringValue(createPayload.id) ?? stringValue(createPayload.uid);
      if (!vercelDeploymentId) throw new Error("VERCEL_DEPLOYMENT_ID_MISSING");
      const status = normalizeVercelStatus(createPayload);
      const url = normalizeDeploymentUrl(stringValue(createPayload.url));
      await this.updateDeployment(deploymentId, {
        status,
        deployServiceJobId: vercelDeploymentId,
        url: status === "completed" ? url : undefined,
        completedAt: status === "completed" ? new Date() : undefined,
        metadata: {
          provider: "vercel",
          target: VERCEL_TARGET,
          vercelDeploymentId,
          vercelProjectId: vercelProject.id,
          vercelProjectName: vercelProject.name,
          vercelTeamId: process.env.VERCEL_TEAM_ID?.trim() || null,
          vercelStatus: stringValue(createPayload.readyState) ?? stringValue(createPayload.status),
          inspectorUrl: stringValue(createPayload.inspectorUrl),
        } as any,
      });
      if (status === "failed") {
        await this.markFailed(deploymentId, vercelErrorMessage(createPayload));
        return;
      }
      if (status !== "completed") await this.pollJob(deploymentId, vercelDeploymentId, Date.now());
    } catch (error) {
      await this.markFailed(deploymentId, error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureVercelProject(
    project: { id: string; name: string; githubUrl: string; metadata: unknown },
    githubRepo: GithubRepository,
  ) {
    const metadata = asObject(project.metadata);
    const existingId = stringValue(metadata.vercelProjectId);
    const existingName = stringValue(metadata.vercelProjectName);
    if (existingId && existingName) {
      await this.syncVercelEnv(existingId);
      return { id: existingId, name: existingName };
    }

    const name = buildVercelProjectName(project.name, project.id);
    const payload = await vercelRequest("/v11/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        gitRepository: {
          type: "github",
          repo: `${githubRepo.owner}/${githubRepo.repo}`,
        },
      }),
    });
    const vercelProjectId = stringValue(payload.id);
    const vercelProjectName = stringValue(payload.name) ?? name;
    if (!vercelProjectId) throw new Error("VERCEL_PROJECT_ID_MISSING");

    const nextMetadata = {
      ...metadata,
      vercelProjectId,
      vercelProjectName,
      vercelTeamId: process.env.VERCEL_TEAM_ID?.trim() || null,
      vercelCreatedAt: new Date().toISOString(),
    };
    await this.prisma.project.update({
      where: { id: project.id },
      data: { metadata: nextMetadata as any },
    });
    await this.syncVercelEnv(vercelProjectId);
    return { id: vercelProjectId, name: vercelProjectName };
  }

  private async syncVercelEnv(vercelProjectId: string) {
    const keys = parseEnvKeys(process.env.VERCEL_DEPLOY_ENV_KEYS);
    for (const key of keys) {
      const value = process.env[key];
      if (value === undefined) continue;
      await vercelRequest(`/v10/projects/${encodeURIComponent(vercelProjectId)}/env?upsert=true`, {
        method: "POST",
        body: JSON.stringify({
          key,
          value,
          type: "encrypted",
          target: [VERCEL_TARGET],
        }),
      });
    }
  }

  private async pollJob(deploymentId: string, vercelDeploymentId: string, startedAt: number) {
    if (Date.now() - startedAt > DEPLOY_TIMEOUT_MS) {
      await this.markFailed(deploymentId, "DEPLOY_TIMEOUT");
      return;
    }
    try {
      const payload = await vercelRequest(`/v13/deployments/${encodeURIComponent(vercelDeploymentId)}`, {
        method: "GET",
      });
      const status = normalizeVercelStatus(payload);
      const url = normalizeDeploymentUrl(stringValue(payload.url));
      if (status === "completed") {
        await this.updateDeployment(deploymentId, {
          status: "completed",
          url,
          completedAt: new Date(),
          metadata: {
            provider: "vercel",
            target: VERCEL_TARGET,
            vercelDeploymentId,
            vercelStatus: stringValue(payload.readyState) ?? stringValue(payload.status),
            inspectorUrl: stringValue(payload.inspectorUrl),
          } as any,
        });
        return;
      }
      if (status === "failed") {
        await this.markFailed(deploymentId, vercelErrorMessage(payload));
        return;
      }
      await this.updateDeployment(deploymentId, {
        status: "running",
        metadata: {
          provider: "vercel",
          target: VERCEL_TARGET,
          vercelDeploymentId,
          vercelStatus: stringValue(payload.readyState) ?? stringValue(payload.status),
          inspectorUrl: stringValue(payload.inspectorUrl),
        } as any,
      });
    } catch (error) {
      await this.markFailed(deploymentId, error instanceof Error ? error.message : String(error));
      return;
    }
    setTimeout(() => void this.pollJob(deploymentId, vercelDeploymentId, startedAt), POLL_INTERVAL_MS);
  }

  private async updateDeployment(deploymentId: string, data: Prisma.DeploymentUpdateArgs["data"]) {
    const existing = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { metadata: true },
    });
    const nextData = { ...data } as Prisma.DeploymentUpdateArgs["data"];
    if ("metadata" in nextData) {
      nextData.metadata = {
        ...asObject(existing?.metadata),
        ...asObject(nextData.metadata),
      } as any;
    }
    const deployment = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: nextData,
    });
    await this.syncDeploymentMessage(deployment.id);
    return deployment;
  }

  private async syncDeploymentMessage(deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true },
    });
    if (!deployment?.triggerMessageId) return null;
    const existing = await this.prisma.message.findUnique({ where: { id: deployment.triggerMessageId } });
    if (!existing) return null;
    const contentJson = asObject(existing.contentJson);
    const metadata = asObject(deployment.metadata);
    const statusText = deploymentStatusText(deployment.status);
    const contentText = `${statusText}：${deployment.project.name}@${deployment.commitSha.slice(0, 12)}`;
    const message = await this.prisma.message.update({
      where: { id: existing.id },
      data: {
        contentText,
        contentJson: {
          ...contentJson,
          parts: [
            {
              id: "deploy_status",
              type: "deploy_status",
              title: statusText,
              url: deployment.url,
              text: deployment.errorMessage ?? deployment.url ?? "",
              metadata: {
                provider: "vercel",
                deploymentId: deployment.id,
                projectId: deployment.projectId,
                projectName: deployment.project.name,
                githubUrl: deployment.project.githubUrl,
                commitSha: deployment.commitSha,
                status: deployment.status,
                target: VERCEL_TARGET,
                targetLabel: "Vercel Production",
                vercelDeploymentId: stringValue(metadata.vercelDeploymentId) ?? deployment.deployServiceJobId,
                vercelProjectId: stringValue(metadata.vercelProjectId),
                vercelProjectName: stringValue(metadata.vercelProjectName),
                inspectorUrl: stringValue(metadata.inspectorUrl),
                errorMessage: deployment.errorMessage,
              },
            },
          ],
        } as any,
      },
    });
    const dto = mapMessage(message);
    this.gateway.emitMessage(dto);
    return dto;
  }

  private async markFailed(deploymentId: string, message: string) {
    await this.updateDeployment(deploymentId, {
      status: "failed",
      errorMessage: message,
      completedAt: new Date(),
    });
  }
}

type GithubRepository = {
  owner: string;
  repo: string;
};

async function vercelRequest(path: string, init: RequestInit) {
  const token = process.env.VERCEL_TOKEN?.trim();
  if (!token) throw new Error("VERCEL_TOKEN_NOT_CONFIGURED");
  const url = new URL(`${VERCEL_API_BASE_URL}${path}`);
  const teamId = process.env.VERCEL_TEAM_ID?.trim();
  if (teamId) url.searchParams.set("teamId", teamId);
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      stringValue(payload.error) ??
      (payload.error && typeof payload.error === "object" ? stringValue((payload.error as Record<string, unknown>).message) : undefined) ??
      stringValue(payload.message) ??
      `Vercel API HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function parseGithubRepository(githubUrl: string): GithubRepository | null {
  const normalized = githubUrl.trim().replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(normalized);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  try {
    const url = new URL(normalized);
    if (url.hostname !== "github.com") return null;
    const [owner, repo] = url.pathname.replace(/^\/|\/$/g, "").split("/");
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

function buildVercelProjectName(name: string, projectId: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return `${slug || "agenthub-project"}-${projectId.slice(0, 8)}`;
}

function parseEnvKeys(value: string | undefined) {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function normalizeVercelStatus(payload: Record<string, unknown>) {
  const raw = (stringValue(payload.readyState) ?? stringValue(payload.status) ?? stringValue(payload.state) ?? "").toUpperCase();
  if (raw === "READY") return "completed";
  if (raw === "ERROR" || raw === "CANCELED" || raw === "DELETED") return "failed";
  return "running";
}

function normalizeDeploymentUrl(value: string | undefined) {
  if (!value) return undefined;
  if (/^https?:\/\//.test(value)) return value;
  return `https://${value}`;
}

function vercelErrorMessage(payload: Record<string, unknown>) {
  return (
    stringValue(payload.errorMessage) ??
    stringValue(payload.readyStateReason) ??
    stringValue(payload.errorCode) ??
    stringValue(payload.error) ??
    "VERCEL_DEPLOY_FAILED"
  );
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function deploymentStatusText(status: string) {
  if (status === "completed") return "Vercel 部署完成";
  if (status === "failed") return "Vercel 部署失败";
  if (status === "running") return "Vercel 部署中";
  return "Vercel 部署排队";
}
