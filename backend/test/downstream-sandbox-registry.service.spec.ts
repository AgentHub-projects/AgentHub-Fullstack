import { describe, expect, it, vi } from "vitest";
import { DownstreamSandboxRegistryService } from "../src/modules/hub/services/downstream-sandbox-registry.service";

describe("DownstreamSandboxRegistryService", () => {
  it("returns downstream session id for filesystem connection", async () => {
    const service = new DownstreamSandboxRegistryService(prismaMock("downstream-session-1") as any);

    await expect(service.getFilesystemConnection("session-1")).resolves.toEqual({
      downstreamSessionId: "downstream-session-1",
    });
  });

  it("rejects filesystem connection before downstream session is ready", async () => {
    const service = new DownstreamSandboxRegistryService(prismaMock(null) as any);

    await expect(service.getFilesystemConnection("session-1")).rejects.toThrow("DOWNSTREAM_SESSION_NOT_READY");
  });
});

function prismaMock(downstreamSessionId: string | null) {
  return {
    session: {
      findUnique: vi.fn().mockResolvedValue({
        id: "session-1",
        status: "active",
        downstreamSessionId,
      }),
    },
  };
}
