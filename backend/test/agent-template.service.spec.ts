import { describe, expect, it, vi } from "vitest";
import { AgentTemplateService } from "../src/modules/hub/services/agent-template.service";

const now = new Date("2026-06-02T12:00:00.000Z");

describe("AgentTemplateService tools", () => {
  it("stores template tools as default capabilities on create", async () => {
    const prisma = createPrisma();
    prisma.agentTemplate.create.mockImplementation(async ({ data }: any) => templateRow(data));
    const service = new AgentTemplateService(prisma as any);

    const result = await service.create({
      name: "Deploy Agent",
      description: "负责部署",
      systemPrompt: "system",
      defaultProvider: "open-code",
      tools: ["shell", "git", "shell", " "],
    });

    expect(prisma.agentTemplate.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        defaultCapabilities: ["shell", "git"],
        promptConfig: { tools: ["shell", "git"] },
      }),
    }));
    expect(result.defaultCapabilities).toEqual(["shell", "git"]);
  });

  it("keeps template capabilities aligned when tools are updated", async () => {
    const prisma = createPrisma();
    prisma.agentTemplate.findUnique.mockResolvedValue(templateRow({ promptConfig: { tools: ["shell"] } }));
    prisma.agentTemplate.update.mockImplementation(async ({ data }: any) =>
      templateRow({ ...data, promptConfig: data.promptConfig, defaultCapabilities: data.defaultCapabilities }),
    );
    const service = new AgentTemplateService(prisma as any);

    await service.update(10, { tools: ["browser", "deploy"] });

    expect(prisma.agentTemplate.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 10 },
      data: expect.objectContaining({
        defaultCapabilities: ["browser", "deploy"],
        promptConfig: { tools: ["browser", "deploy"] },
      }),
    }));
  });
});

function createPrisma() {
  return {
    provider: {
      upsert: vi.fn(async () => ({ id: 1, name: "open-code" })),
      findMany: vi.fn(async () => [{ id: 1, name: "open-code" }]),
    },
    agentTemplate: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
}

function templateRow(overrides: Record<string, any> = {}) {
  return {
    id: 10,
    name: "Deploy Agent",
    description: "负责部署",
    defaultProviderId: 1,
    systemPrompt: "system",
    promptConfig: {},
    defaultCapabilities: [],
    defaultModelConfig: {},
    metadata: {},
    status: "enabled",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
