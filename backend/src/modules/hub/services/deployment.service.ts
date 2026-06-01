import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { DeploymentTarget, StartDeploymentRequest } from "@agenthub/shared";
import { mapDeployment, mapMessage, mapSession, asObject } from "../mappers/hub.mappers";
import { PrismaService } from "./prisma.service";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";

const POLL_INTERVAL_MS = 3000;
const DEPLOY_TIMEOUT_MS = 30 * 60 * 1000;

@Injectable()
export class DeploymentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HubRealtimeGateway) private readonly gateway: HubRealtimeGateway,
  ) {}

  async start(sessionId: string, input: StartDeploymentRequest = {}) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: true, runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!session?.projectId || !session.project) throw new Error("PROJECT_NOT_BOUND");
    const metadata = asObject(session.metadata);
    const commitSha = stringValue(metadata.latestSuccessfulPushCommitSha);
    if (!commitSha) throw new Error("NO_SUCCESSFUL_PUSH_COMMIT");
    const target = normalizeDeploymentTarget(input.target);
    const sourceArchiveUrl = githubArchiveUrl(session.project.githubUrl, commitSha);
    if (target === "source_archive" && !sourceArchiveUrl) throw new Error("SOURCE_ARCHIVE_UNAVAILABLE");
    const initialStatus = target === "source_archive" ? "completed" : "queued";
    const initialTitle = deploymentStatusText(initialStatus, target);

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
                projectId: session.projectId,
                projectName: session.project.name,
                commitSha,
                status: initialStatus,
                target,
                sourceArchiveUrl,
              },
            },
          ],
        } as any,
      },
    });

    const deployment = await this.prisma.deployment.create({
      data: {
        sessionId,
        projectId: session.projectId,
        triggerMessageId: message.id,
        commitSha,
        status: initialStatus,
        completedAt: target === "source_archive" ? new Date() : undefined,
        metadata: { target, sourceArchiveUrl } as any,
      },
    });
    const syncedMessage = await this.syncDeploymentMessage(deployment.id);
    this.gateway.emitSession(mapSession(session));
    if (target !== "source_archive") void this.runDeployJob(deployment.id);
    return { deployment: mapDeployment(deployment), message: syncedMessage ?? mapMessage(message) };
  }

  private async runDeployJob(deploymentId: string) {
    const deployServiceUrl = process.env.DEPLOY_SERVICE_URL?.replace(/\/$/, "");
    if (!deployServiceUrl) {
      await this.markFailed(deploymentId, "DEPLOY_SERVICE_URL is not configured");
      return;
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true },
    });
    if (!deployment) return;
    const metadata = asObject(deployment.metadata);
    const target = normalizeDeploymentTarget(metadata.target);

    try {
      const response = await fetch(`${deployServiceUrl}/deployments`, {
        method: "POST",
        headers: deployHeaders(),
        body: JSON.stringify({
          githubUrl: deployment.project.githubUrl,
          defaultBranch: deployment.project.defaultBranch,
          commitSha: deployment.commitSha,
          target,
          deploymentTarget: target,
        }),
      });
      if (!response.ok) throw new Error(`Deploy service HTTP ${response.status}`);
      const payload = (await response.json()) as Record<string, unknown>;
      const jobId = stringValue(payload.jobId) ?? stringValue(payload.id);
      await this.updateDeployment(deploymentId, {
        status: "running",
        deployServiceJobId: jobId,
        metadata: { jobId, target } as any,
      });
      if (jobId) await this.pollJob(deploymentId, jobId, Date.now());
    } catch (error) {
      await this.markFailed(deploymentId, error instanceof Error ? error.message : String(error));
    }
  }

  private async pollJob(deploymentId: string, jobId: string, startedAt: number) {
    if (Date.now() - startedAt > DEPLOY_TIMEOUT_MS) {
      await this.markFailed(deploymentId, "DEPLOY_TIMEOUT");
      return;
    }
    try {
      const deployServiceUrl = process.env.DEPLOY_SERVICE_URL!.replace(/\/$/, "");
      const response = await fetch(`${deployServiceUrl}/deployments/${encodeURIComponent(jobId)}`, {
        headers: deployHeaders(),
      });
      if (!response.ok) throw new Error(`Deploy status HTTP ${response.status}`);
      const payload = (await response.json()) as Record<string, unknown>;
      const status = stringValue(payload.status) ?? "running";
      const url = stringValue(payload.url) ?? stringValue(payload.previewUrl);
      if (status === "completed" || status === "ready" || status === "success") {
        await this.updateDeployment(deploymentId, {
          status: "completed",
          url,
          completedAt: new Date(),
          metadata: payload as any,
        });
        return;
      }
      if (status === "failed" || status === "error") {
        await this.markFailed(deploymentId, stringValue(payload.error) ?? "DEPLOY_FAILED");
        return;
      }
      await this.updateDeployment(deploymentId, {
        status: "running",
        metadata: payload as any,
      });
    } catch (error) {
      await this.markFailed(deploymentId, error instanceof Error ? error.message : String(error));
      return;
    }
    setTimeout(() => void this.pollJob(deploymentId, jobId, startedAt), POLL_INTERVAL_MS);
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
    const target = normalizeDeploymentTarget(metadata.target);
    const statusText = deploymentStatusText(deployment.status, target);
    const contentText = `${statusText}：${deployment.project.name}@${deployment.commitSha.slice(0, 12)}`;
    const sourceArchiveUrl =
      stringValue(metadata.sourceArchiveUrl) ?? githubArchiveUrl(deployment.project.githubUrl, deployment.commitSha);
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
                deploymentId: deployment.id,
                projectId: deployment.projectId,
                projectName: deployment.project.name,
                githubUrl: deployment.project.githubUrl,
                commitSha: deployment.commitSha,
                status: deployment.status,
                target,
                targetLabel: deploymentTargetLabel(target),
                jobId: deployment.deployServiceJobId,
                errorMessage: deployment.errorMessage,
                sourceArchiveUrl,
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

function deployHeaders() {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.DEPLOY_SERVICE_API_KEY) headers.Authorization = `Bearer ${process.env.DEPLOY_SERVICE_API_KEY}`;
  return headers;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeDeploymentTarget(value: unknown): DeploymentTarget {
  if (value === "container" || value === "source_archive") return value;
  return "static";
}

function deploymentTargetLabel(target: DeploymentTarget) {
  if (target === "container") return "容器化部署";
  if (target === "source_archive") return "源码包";
  return "静态站点";
}

function deploymentStatusText(status: string, target: DeploymentTarget = "static") {
  const label = deploymentTargetLabel(target);
  if (target === "source_archive") {
    if (status === "failed") return "源码包生成失败";
    return "源码包已生成";
  }
  if (status === "completed") return `${label}完成`;
  if (status === "failed") return `${label}失败`;
  if (status === "running") return `${label}部署中`;
  return `${label}排队`;
}

function githubArchiveUrl(githubUrl: string, commitSha: string) {
  const normalized = githubUrl.replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/.exec(normalized);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}/archive/${commitSha}.zip`;
  try {
    const url = new URL(normalized);
    if (url.hostname !== "github.com") return null;
    const [owner, repo] = url.pathname.replace(/^\/|\/$/g, "").split("/");
    if (!owner || !repo) return null;
    return `https://github.com/${owner}/${repo}/archive/${commitSha}.zip`;
  } catch {
    return null;
  }
}
