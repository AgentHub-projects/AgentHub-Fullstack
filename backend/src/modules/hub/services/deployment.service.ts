import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
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

  async start(sessionId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { project: true, runs: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!session?.projectId || !session.project) throw new Error("PROJECT_NOT_BOUND");
    const metadata = asObject(session.metadata);
    const commitSha = stringValue(metadata.latestSuccessfulPushCommitSha);
    if (!commitSha) throw new Error("NO_SUCCESSFUL_PUSH_COMMIT");

    const message = await this.prisma.message.create({
      data: {
        sessionId,
        role: "system",
        contentText: `部署已触发：${session.project.name}@${commitSha.slice(0, 12)}`,
        contentJson: {
          parts: [
            {
              id: "deploy_status",
              type: "deploy_status",
              title: "部署中",
              metadata: { projectId: session.projectId, commitSha, status: "queued" },
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
        status: "queued",
      },
    });
    const syncedMessage = await this.syncDeploymentMessage(deployment.id);
    this.gateway.emitSession(mapSession(session));
    void this.runDeployJob(deployment.id);
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

    try {
      const response = await fetch(`${deployServiceUrl}/deployments`, {
        method: "POST",
        headers: deployHeaders(),
        body: JSON.stringify({
          githubUrl: deployment.project.githubUrl,
          defaultBranch: deployment.project.defaultBranch,
          commitSha: deployment.commitSha,
        }),
      });
      if (!response.ok) throw new Error(`Deploy service HTTP ${response.status}`);
      const payload = (await response.json()) as Record<string, unknown>;
      const jobId = stringValue(payload.jobId) ?? stringValue(payload.id);
      await this.updateDeployment(deploymentId, {
        status: "running",
        deployServiceJobId: jobId,
        metadata: { jobId } as any,
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
    const deployment = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data,
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
    const statusText = deploymentStatusText(deployment.status);
    const contentText = `${statusText}：${deployment.project.name}@${deployment.commitSha.slice(0, 12)}`;
    const sourceArchiveUrl = githubArchiveUrl(deployment.project.githubUrl, deployment.commitSha);
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

function deploymentStatusText(status: string) {
  if (status === "completed") return "部署完成";
  if (status === "failed") return "部署失败";
  if (status === "running") return "部署中";
  return "部署排队";
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
