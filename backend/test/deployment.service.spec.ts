import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentService } from "../src/modules/hub/services/deployment.service";

const now = new Date("2026-06-01T10:00:00.000Z");
const commitSha = "abcdef1234567890abcdef1234567890abcdef12";
const project = {
  id: "project-1",
  name: "AgentHub Demo",
  githubUrl: "https://github.com/acme/agenthub.git",
  defaultBranch: "main",
  status: "active",
  metadata: {},
  createdAt: now,
  updatedAt: now,
};

describe("DeploymentService Vercel deployment", () => {
  const originalEnv = {
    VERCEL_TOKEN: process.env.VERCEL_TOKEN,
    VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
    VERCEL_DEPLOY_ENV_KEYS: process.env.VERCEL_DEPLOY_ENV_KEYS,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  };
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.VERCEL_TOKEN = "vercel-token";
    process.env.VERCEL_TEAM_ID = "team-1";
    process.env.VERCEL_DEPLOY_ENV_KEYS = "";
    delete process.env.NEXT_PUBLIC_API_URL;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  afterEach(() => {
    process.env.VERCEL_TOKEN = originalEnv.VERCEL_TOKEN;
    process.env.VERCEL_TEAM_ID = originalEnv.VERCEL_TEAM_ID;
    process.env.VERCEL_DEPLOY_ENV_KEYS = originalEnv.VERCEL_DEPLOY_ENV_KEYS;
    process.env.NEXT_PUBLIC_API_URL = originalEnv.NEXT_PUBLIC_API_URL;
    globalThis.fetch = originalFetch;
  });

  it("reports missing Vercel token before deployment", async () => {
    process.env.VERCEL_TOKEN = "";
    const { service, prisma } = createService();
    prisma.session.findUnique.mockResolvedValue(sessionRow());

    await expect(service.preflight("session-1")).resolves.toMatchObject({
      canDeploy: false,
      missing: ["vercel_token"],
      projectBound: true,
      latestSuccessfulPushCommitSha: commitSha,
      vercelConfigured: false,
      vercelProjectBound: false,
    });
  });

  it("creates a Vercel project, syncs whitelisted env, and starts a production deployment", async () => {
    process.env.VERCEL_DEPLOY_ENV_KEYS = "NEXT_PUBLIC_API_URL,MISSING_KEY";
    process.env.NEXT_PUBLIC_API_URL = "https://api.example";
    const { service, prisma, state } = createService({ project });
    fetchMock.mockImplementation(async (url: URL | string, init?: RequestInit) => {
      const path = requestPath(url);
      if (path.startsWith("/v11/projects")) return jsonResponse({ id: "prj_1", name: "agenthub-demo-project-1" });
      if (path.startsWith("/v10/projects/prj_1/env")) return jsonResponse({ created: {}, failed: [] }, 201);
      if (path.startsWith("/v13/deployments")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          project: "prj_1",
          target: "production",
          gitSource: {
            type: "github",
            org: "acme",
            repo: "agenthub",
            ref: "main",
            sha: commitSha,
          },
        });
        return jsonResponse({
          id: "dpl_1",
          status: "READY",
          readyState: "READY",
          url: "agenthub-demo.vercel.app",
          inspectorUrl: "https://vercel.com/acme/agenthub/dpl_1",
        });
      }
      throw new Error(`Unexpected Vercel request: ${path}`);
    });

    await (service as any).runDeployJob("deploy-1");

    expect(state.deployment.errorMessage).toBeNull();
    expect(prisma.project.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "project-1" },
      data: {
        metadata: expect.objectContaining({
          vercelProjectId: "prj_1",
          vercelProjectName: "agenthub-demo-project-1",
          vercelTeamId: "team-1",
        }),
      },
    }));
    const envCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/v10/projects/prj_1/env"));
    expect(envCall).toBeTruthy();
    expect(JSON.parse(String(envCall?.[1]?.body))).toMatchObject({
      key: "NEXT_PUBLIC_API_URL",
      value: "https://api.example",
      type: "encrypted",
      target: ["production"],
    });
    expect(state.deployment).toMatchObject({
      status: "completed",
      deployServiceJobId: "dpl_1",
      url: "https://agenthub-demo.vercel.app",
      metadata: expect.objectContaining({
        provider: "vercel",
        target: "production",
        vercelDeploymentId: "dpl_1",
        vercelProjectId: "prj_1",
      }),
    });
    expect(prisma.message.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contentText: expect.stringContaining("Vercel 部署完成") }),
    }));
  });

  it("reuses an existing Vercel project without creating another project", async () => {
    const { service, state } = createService({
      project: {
        ...project,
        metadata: { vercelProjectId: "prj_existing", vercelProjectName: "existing-project" },
      },
    });
    fetchMock.mockImplementation(async (url: URL | string, init?: RequestInit) => {
      const path = requestPath(url);
      if (path.startsWith("/v13/deployments")) {
        const body = JSON.parse(String(init?.body));
        expect(body.project).toBe("prj_existing");
        return jsonResponse({ id: "dpl_2", status: "READY", readyState: "READY", url: "existing.vercel.app" });
      }
      throw new Error(`Unexpected Vercel request: ${path}`);
    });

    await (service as any).runDeployJob("deploy-1");

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/v11/projects"))).toBe(false);
    expect(state.deployment.metadata).toMatchObject({
      vercelProjectId: "prj_existing",
      vercelProjectName: "existing-project",
      vercelDeploymentId: "dpl_2",
    });
  });

  it("maps Vercel ERROR deployments to failed AgentHub deployments", async () => {
    const { service, state } = createService({
      project: {
        ...project,
        metadata: { vercelProjectId: "prj_existing", vercelProjectName: "existing-project" },
      },
    });
    fetchMock.mockResolvedValue(jsonResponse({
      id: "dpl_failed",
      status: "ERROR",
      readyState: "ERROR",
      errorMessage: "Build failed",
    }));

    await (service as any).runDeployJob("deploy-1");

    expect(state.deployment).toMatchObject({
      status: "failed",
      errorMessage: "Build failed",
      completedAt: expect.any(Date),
    });
  });

  it("reports missing project, missing commit, and unsupported GitHub URL clearly", async () => {
    const { service, prisma } = createService();

    prisma.session.findUnique.mockResolvedValueOnce(sessionRow({ projectId: null, project: null, metadata: {} }));
    await expect(service.preflight("session-1")).resolves.toMatchObject({
      canDeploy: false,
      missing: ["project", "commit"],
    });

    prisma.session.findUnique.mockResolvedValueOnce(sessionRow({ metadata: {} }));
    await expect(service.start("session-1", {})).rejects.toThrow("NO_SUCCESSFUL_PUSH_COMMIT");

    prisma.session.findUnique.mockResolvedValueOnce(sessionRow({
      project: { ...project, githubUrl: "https://git.example/acme/agenthub.git" },
    }));
    await expect(service.start("session-1", {})).rejects.toThrow("GITHUB_REPOSITORY_UNSUPPORTED");
  });
});

function createService(input: { project?: Record<string, any> } = {}) {
  const activeProject = input.project ?? project;
  const state = {
    deployment: deploymentRow({ project: activeProject, metadata: { ...asRecord(activeProject.metadata) } }),
  };
  const message = messageRow({ id: "message-1" });
  const prisma = {
    session: { findUnique: vi.fn(), update: vi.fn(async () => sessionRow({ project: activeProject })) },
    project: {
      update: vi.fn(async ({ data }: any) => {
        activeProject.metadata = data.metadata;
        return activeProject;
      }),
    },
    message: {
      create: vi.fn(async () => message),
      findUnique: vi.fn(async () => message),
      update: vi.fn(async ({ data }: any) => messageRow({ ...message, ...data })),
    },
    deployment: {
      create: vi.fn(async ({ data }: any) => {
        state.deployment = deploymentRow({ ...data, project: activeProject });
        return state.deployment;
      }),
      findUnique: vi.fn(async ({ include, select }: any) => {
        if (select?.metadata) return { metadata: state.deployment.metadata };
        return include?.project ? { ...state.deployment, project: activeProject } : state.deployment;
      }),
      update: vi.fn(async ({ data }: any) => {
        state.deployment = deploymentRow({
          ...state.deployment,
          ...data,
          metadata: data.metadata ?? state.deployment.metadata,
          project: activeProject,
        });
        return state.deployment;
      }),
    },
  };
  prisma.session.findUnique.mockResolvedValue(sessionRow({ project: activeProject }));
  const gateway = { emitSession: vi.fn(), emitMessage: vi.fn() };
  return { prisma, gateway, state, service: new DeploymentService(prisma as any, gateway as any) };
}

function sessionRow(overrides: Record<string, any> = {}) {
  return {
    id: "session-1",
    title: "Deploy session",
    status: "active",
    projectId: overrides.project?.id ?? project.id,
    project,
    metadata: { latestSuccessfulPushCommitSha: commitSha },
    runs: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
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

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestPath(url: URL | string | Request) {
  const raw = typeof url === "string" || url instanceof URL ? String(url) : url.url;
  const parsed = new URL(raw);
  return `${parsed.pathname}${parsed.search}`;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
