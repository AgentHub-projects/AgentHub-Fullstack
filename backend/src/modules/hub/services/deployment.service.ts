import { Inject, Injectable } from "@nestjs/common";
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
    this.gateway.emitSession(mapSession(session));
    void this.runDeployJob(deployment.id);
    return { deployment: mapDeployment(deployment), message: mapMessage(message) };
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
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: "running", deployServiceJobId: jobId },
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
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: { status: "completed", url, completedAt: new Date(), metadata: payload as any },
        });
        return;
      }
      if (status === "failed" || status === "error") {
        await this.markFailed(deploymentId, stringValue(payload.error) ?? "DEPLOY_FAILED");
        return;
      }
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: "running", metadata: payload as any },
      });
    } catch (error) {
      await this.markFailed(deploymentId, error instanceof Error ? error.message : String(error));
      return;
    }
    setTimeout(() => void this.pollJob(deploymentId, jobId, startedAt), POLL_INTERVAL_MS);
  }

  private async markFailed(deploymentId: string, message: string) {
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: "failed", errorMessage: message, completedAt: new Date() },
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
