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

  it("keeps filesystem mapping when sandbox workspace id is omitted", async () => {
    const service = new DownstreamSandboxRegistryService(prismaMock() as any);
    await service.saveFromSessionResult("session-1", "downstream-session-1", {
      sandbox: {
        baseUrl: "http://sandbox.local",
      },
    });

    await expect(service.getFilesystemConnection("session-1")).resolves.toEqual({
      sandboxBaseUrl: "http://sandbox.local",
      downstreamSessionId: "downstream-session-1",
      workspaceId: null,
      branchOptions: [],
    });
  });

  it("returns filesystem connection info with downstream session id and branch options", async () => {
    const service = new DownstreamSandboxRegistryService(prismaMock() as any);
    await service.saveFromSessionResult("session-1", "downstream-session-1", {
      sandbox: {
        baseUrl: "http://sandbox.local",
        workspaceId: "workspace-1",
        agentBranches: { 7: "agent-7", 8: "agent-8", duplicate: "agent-7" },
      },
    });

    const result = await service.getFilesystemConnection("session-1");

    expect(result).toEqual({
      sandboxBaseUrl: "http://sandbox.local",
      downstreamSessionId: "downstream-session-1",
      workspaceId: "workspace-1",
      branchOptions: ["agent-7", "agent-8"],
    });
  });

  it("rejects filesystem connection when Redis mapping is missing", async () => {
    const service = new DownstreamSandboxRegistryService(prismaMock() as any);

    await expect(service.getFilesystemConnection("session-1")).rejects.toThrow("DOWNSTREAM_SANDBOX_NOT_READY");
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
