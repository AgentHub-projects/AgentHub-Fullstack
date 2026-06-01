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

  it("rejects creating session agents from disabled templates", async () => {
    const template = templateRow({ status: "disabled" });
    const prisma = {
      agentTemplate: {
        findUnique: vi.fn(async () => template),
      },
      agent: {
        create: vi.fn(),
      },
      sessionAgent: {
        create: vi.fn(),
      },
    };
    const service = new AgentRegistryService(prisma as any);

    await expect(service.createAgentFromTemplate("session-1", template.id, undefined, undefined, "member"))
      .rejects.toThrow("Template disabled");

    expect(prisma.agent.create).not.toHaveBeenCalled();
    expect(prisma.sessionAgent.create).not.toHaveBeenCalled();
  });
});

describe("AgentRegistryService downstream config", () => {
  it("returns a minimal executable agent config", async () => {
    const template = templateRow({
      promptConfig: { temperature: 0.2 },
      defaultCapabilities: ["frontend", "git"],
      defaultModelConfig: { model: "claude-sonnet" },
      metadata: { tools: ["shell"] },
    });
    const prisma = {
      provider: {
        findMany: vi.fn(async () => [{ id: 1, name: "claude-code" }]),
      },
      agent: {
        findUnique: vi.fn(async () => agentRow({ id: 7, name: "frontend-agent", providerId: 1, template })),
      },
    };
    const service = new AgentRegistryService(prisma as any);

    await expect(service.getDownstreamConfig(7)).resolves.toMatchObject({
      agentId: 7,
      templateId: template.id,
      name: "frontend-agent",
      provider: "claude-code",
      systemPrompt: "system",
      promptConfig: { temperature: 0.2 },
      capabilities: ["frontend", "git"],
      modelConfig: { model: "claude-sonnet" },
      metadata: { tools: ["shell"], agentStatus: "enabled", templateStatus: "enabled" },
    });
  });
});

function templateRow(overrides: Record<string, any> = {}) {
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
    ...overrides,
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
