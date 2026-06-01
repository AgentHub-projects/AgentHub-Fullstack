import { describe, expect, it, vi } from "vitest";
import { AgentRegistryService } from "../src/modules/hub/services/agent-registry.service";

const now = new Date("2026-06-02T11:00:00.000Z");

describe("AgentRegistryService session member metadata", () => {
  it("appends created member agents to session metadata", async () => {
    const template = templateRow();
    const agent = agentRow({ id: 5, name: "frontend-agent-2", template });
    const prisma = {
      provider: {
        findMany: vi.fn(async () => [{ id: 1, name: "claude-code" }]),
      },
      agentTemplate: {
        findUnique: vi.fn(async () => template),
      },
      agent: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async () => agent),
      },
      sessionAgent: {
        create: vi.fn(async () => ({})),
      },
      session: {
        findUnique: vi.fn(async () => ({ metadata: { memberAgentIds: [2] } })),
        update: vi.fn(async () => ({})),
      },
    };
    const service = new AgentRegistryService(prisma as any);

    await service.createAgentFromTemplate("session-1", template.id, undefined, "frontend-agent-2", "member");

    expect(prisma.session.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "session-1" },
      data: expect.objectContaining({
        metadata: expect.objectContaining({ memberAgentIds: [2, 5] }),
      }),
    }));
  });
});

function templateRow() {
  return {
    id: 10,
    name: "Frontend Agent 模板",
    description: "负责前端",
    defaultProviderId: 1,
    systemPrompt: "system",
    promptConfig: {},
    defaultCapabilities: ["frontend"],
    defaultModelConfig: {},
    metadata: {},
    status: "enabled",
    createdAt: now,
    updatedAt: now,
  };
}

function agentRow(overrides: Record<string, any>) {
  return {
    id: 5,
    templateId: 10,
    name: "frontend-agent-2",
    description: "负责前端",
    providerId: 1,
    isDefaultOrchestrator: false,
    status: "enabled",
    createdAt: now,
    updatedAt: now,
    template: templateRow(),
    ...overrides,
  };
}
