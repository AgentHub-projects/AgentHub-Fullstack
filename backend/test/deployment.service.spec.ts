import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentService } from "../src/modules/hub/services/deployment.service";

const now = new Date("2026-06-01T10:00:00.000Z");
const commitSha = "abcdef1234567890abcdef1234567890abcdef12";
const project = {
  id: "project-1",
  name: "AgentHub",
  githubUrl: "https://github.com/acme/agenthub.git",
  defaultBranch: "main",
  status: "active",
  metadata: {},
  createdAt: now,
  updatedAt: now,
};
const sourceArchiveUrl = `https://github.com/acme/agenthub/archive/${commitSha}.zip`;

describe("DeploymentService deployment targets", () => {
  const originalDeployUrl = process.env.DEPLOY_SERVICE_URL;
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    process.env.DEPLOY_SERVICE_URL = originalDeployUrl;
    globalThis.fetch = originalFetch;
  });

  it("generates a source archive card without calling the deploy service", async () => {
    const { service, prisma } = createService();
    const message = messageRow({ id: "message-1" });
    prisma.session.findUnique.mockResolvedValue(sessionRow());
    prisma.message.create.mockResolvedValue(message);
    prisma.deployment.create.mockImplementation(async ({ data }: any) => deploymentRow({ ...data, id: "deploy-1" }));
    prisma.deployment.findUnique.mockResolvedValue(deploymentRow({
      id: "deploy-1",
      status: "completed",
      metadata: { target: "source_archive", sourceArchiveUrl },
      triggerMessageId: "message-1",
      completedAt: now,
      project,
    }));
    prisma.message.findUnique.mockResolvedValue(message);
    prisma.message.update.mockImplementation(async ({ data }: any) => messageRow({ ...message, ...data }));

    const result = await service.start("session-1", { target: "source_archive" });

    expect(prisma.deployment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "completed",
        completedAt: expect.any(Date),
        metadata: expect.objectContaining({ target: "source_archive", sourceArchiveUrl }),
      }),
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.message.contentText).toContain("源码包已生成");
    expect(result.message.parts[0]?.metadata).toMatchObject({ target: "source_archive", sourceArchiveUrl });
  });

  it("passes the container target to the deploy service and preserves deployment metadata", async () => {
    process.env.DEPLOY_SERVICE_URL = "https://deploy.example";
    const { service, prisma } = createService();
    let deployment = deploymentRow({
      id: "deploy-1",
      status: "queued",
      metadata: { target: "container", sourceArchiveUrl },
      triggerMessageId: "message-1",
      project,
    });
    const message = messageRow({ id: "message-1" });
    prisma.deployment.findUnique.mockImplementation(async ({ include, select }: any) => {
      if (select?.metadata) return { metadata: deployment.metadata };
      return include?.project ? { ...deployment, project } : deployment;
    });
    prisma.deployment.update.mockImplementation(async ({ data }: any) => {
      deployment = deploymentRow({ ...deployment, ...data, metadata: data.metadata ?? deployment.metadata });
      return deployment;
    });
    prisma.message.findUnique.mockResolvedValue(message);
    prisma.message.update.mockImplementation(async ({ data }: any) => messageRow({ ...message, ...data }));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return jsonResponse({ jobId: "job-1" });
      expect(url).toBe("https://deploy.example/deployments/job-1");
      return jsonResponse({ status: "completed", url: "https://preview.example" });
    });

    await (service as any).runDeployJob("deploy-1");

    const postBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(postBody).toMatchObject({
      githubUrl: project.githubUrl,
      defaultBranch: "main",
      commitSha,
      target: "container",
      deploymentTarget: "container",
    });
    expect(deployment.metadata).toMatchObject({ target: "container", sourceArchiveUrl });
    expect(prisma.message.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contentText: expect.stringContaining("容器化部署完成") }),
    }));
  });
});

function createService() {
  const prisma = {
    session: { findUnique: vi.fn() },
    message: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    deployment: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  };
  const gateway = { emitSession: vi.fn(), emitMessage: vi.fn() };
  return { prisma, gateway, service: new DeploymentService(prisma as any, gateway as any) };
}

function sessionRow() {
  return {
    id: "session-1",
    title: "Deploy session",
    status: "active",
    projectId: project.id,
    project,
    metadata: { latestSuccessfulPushCommitSha: commitSha },
    runs: [],
    createdAt: now,
    updatedAt: now,
  };
}

function deploymentRow(overrides: Record<string, any> = {}) {
  return {
    id: "deploy-1",
    sessionId: "session-1",
    projectId: project.id,
    triggerMessageId: "message-1",
    commitSha,
    status: "queued",
    deployServiceJobId: null,
    url: null,
    errorMessage: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function messageRow(overrides: Record<string, any> = {}) {
  const contentJson = overrides.contentJson ?? {};
  return {
    id: "message-1",
    sessionId: "session-1",
    role: "system",
    agentId: null,
    parentMessageId: null,
    contentText: "",
    contentJson,
    tokenCount: 0,
    status: "completed",
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function jsonResponse(payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
