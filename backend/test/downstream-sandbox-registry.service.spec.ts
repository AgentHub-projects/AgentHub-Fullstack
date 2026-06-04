import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = vi.hoisted(() => {
  class FakeRedis {
    static instances: FakeRedis[] = [];
    store = new Map<string, string>();
    set = vi.fn(async (key: string, value: string) => {
      this.store.set(key, value);
      return "OK";
    });
    get = vi.fn(async (key: string) => this.store.get(key) ?? null);
    del = vi.fn(async (key: string) => {
      this.store.delete(key);
      return 1;
    });
    disconnect = vi.fn();
    on = vi.fn();

    constructor() {
      FakeRedis.instances.push(this);
    }
  }

  return { FakeRedis };
});

vi.mock("ioredis", () => ({
  default: redisMock.FakeRedis,
}));

import { DownstreamSandboxRegistryService } from "../src/modules/hub/services/downstream-sandbox-registry.service";

const now = new Date("2026-06-03T10:00:00.000Z");

describe("DownstreamSandboxRegistryService", () => {
  beforeEach(() => {
    redisMock.FakeRedis.instances.length = 0;
  });

  it("saves downstream sandbox mapping from session result", async () => {
    const service = new DownstreamSandboxRegistryService(prismaMock() as any);

    await service.saveFromSessionResult("session-1", "downstream-session-1", {
      sandbox: {
        baseUrl: "http://sandbox.local/",
        workspaceId: "workspace-1",
        agentBranches: { 7: "agent-7", 8: "agent-8", empty: "" },
      },
    });

    const redis = latestRedis();
    expect(redis.set).toHaveBeenCalledWith(
      "agenthub:downstream-sandbox:session-1",
      expect.any(String),
      "EX",
      604800,
    );
    const saved = JSON.parse(redis.set.mock.calls[0][1]);
    expect(saved).toEqual(expect.objectContaining({
      agenthubSessionId: "session-1",
      downstreamSessionId: "downstream-session-1",
      sandboxBaseUrl: "http://sandbox.local",
      workspaceId: "workspace-1",
      agentBranches: { 7: "agent-7", 8: "agent-8" },
    }));

    await expect(service.getMapping("session-1")).resolves.toEqual(expect.objectContaining({
      sandboxBaseUrl: "http://sandbox.local",
      workspaceId: "workspace-1",
      agentBranches: { 7: "agent-7", 8: "agent-8" },
    }));
  });

  it("deletes stale mapping when downstream result has no usable sandbox", async () => {
    const service = new DownstreamSandboxRegistryService(prismaMock() as any);

    await service.saveFromSessionResult("session-1", "downstream-session-1", {});

    expect(latestRedis().del).toHaveBeenCalledWith("agenthub:downstream-sandbox:session-1");
  });

  it("lists agents from Redis mapping and marks missing branches unavailable", async () => {
    const service = new DownstreamSandboxRegistryService(prismaMock() as any);
    await service.saveFromSessionResult("session-1", "downstream-session-1", {
      sandbox: {
        baseUrl: "http://sandbox.local",
        workspaceId: "workspace-1",
        agentBranches: { 7: "agent-7" },
      },
    });

    const result = await service.listAgents("session-1");

    expect(result).toEqual({
      sandboxConfigured: true,
      workspaceId: "workspace-1",
      items: [
        {
          agentId: 7,
          agentName: "Frontend Agent",
          branch: "agent-7",
          workspaceId: "workspace-1",
          status: "ready",
          message: null,
        },
        {
          agentId: 8,
          agentName: "Backend Agent",
          branch: null,
          workspaceId: "workspace-1",
          status: "unavailable",
          message: "下游未返回该 Agent 分支",
        },
      ],
    });
  });

  it("returns connection info with latest run id for ready agent", async () => {
    const service = new DownstreamSandboxRegistryService(prismaMock() as any);
    await service.saveFromSessionResult("session-1", "downstream-session-1", {
      sandbox: {
        baseUrl: "http://sandbox.local",
        workspaceId: "workspace-1",
        agentBranches: { 7: "agent-7" },
      },
    });

    await expect(service.connect("session-1", 7)).resolves.toEqual({
      agentId: 7,
      sandboxBaseUrl: "http://sandbox.local",
      workspaceId: "workspace-1",
      branch: "agent-7",
      latestRunId: "run-1",
    });
    await expect(service.connect("session-1", 8)).rejects.toThrow("DOWNSTREAM_SANDBOX_AGENT_BRANCH_NOT_READY");
  });

  it("marks agents unavailable when Redis mapping is missing", async () => {
    const service = new DownstreamSandboxRegistryService(prismaMock() as any);

    const result = await service.listAgents("session-1");

    expect(result.sandboxConfigured).toBe(false);
    expect(result.items.map((item) => item.message)).toEqual(["下游沙箱尚未就绪", "下游沙箱尚未就绪"]);
  });
});

function latestRedis(): InstanceType<typeof redisMock.FakeRedis> {
  const redis = redisMock.FakeRedis.instances.at(-1);
  expect(redis).toBeDefined();
  return redis!;
}

function prismaMock() {
  return {
    session: {
      findUnique: vi.fn().mockResolvedValue({
        id: "session-1",
        title: "Sandbox Demo",
        status: "active",
        metadata: {},
        createdAt: now,
        updatedAt: now,
        participants: [
          {
            agentId: 7,
            participantRole: "member",
            createdAt: now,
            agent: { id: 7, name: "Frontend Agent" },
          },
          {
            agentId: 8,
            participantRole: "member",
            createdAt: now,
            agent: { id: 8, name: "Backend Agent" },
          },
        ],
      }),
    },
    agentRun: {
      findFirst: vi.fn().mockResolvedValue({ id: "run-1" }),
    },
  };
}
