import { describe, expect, it, vi } from "vitest";
import type { BuildTemplateDraft } from "@agenthub/shared";
import {
  BuilderService,
  normalizeDraftForConversation,
  parseBuilderAssistantContent,
} from "../src/modules/hub/services/builder.service";

describe("parseBuilderAssistantContent", () => {
  it("extracts options from the JSON envelope", () => {
    const parsed = parseBuilderAssistantContent(JSON.stringify({
      text: "请选择名称",
      options: ["前端 Agent", "后端 Agent", "Review Agent"],
      draft: null,
    }));

    expect(parsed.text).toBe("请选择名称");
    expect(parsed.options).toEqual(["前端 Agent", "后端 Agent", "Review Agent"]);
    expect(parsed.draft).toBeNull();
  });

  it("extracts a template draft from the JSON envelope", () => {
    const parsed = parseBuilderAssistantContent(JSON.stringify({
      text: "模板草稿如下。",
      options: [],
      draft: {
        name: "前端 UI 审查 Agent",
        description: "审查前端组件、样式和交互体验。",
        systemPrompt: "你是一个前端审查助手。",
        defaultProvider: "claude-code",
      },
    }));

    expect(parsed.text).toBe("模板草稿如下。");
    expect(parsed.options).toEqual([]);
    expect(parsed.draft).toEqual({
      name: "前端 UI 审查 Agent",
      description: "审查前端组件、样式和交互体验。",
      systemPrompt: "你是一个前端审查助手。",
      defaultProvider: "claude-code",
    });
  });

  it("ignores malformed envelope fields", () => {
    const parsed = parseBuilderAssistantContent(JSON.stringify({
      text: "请选择",
      options: ["有效选项", 1, ""],
      draft: { name: "缺字段" },
    }));

    expect(parsed.text).toBe("请选择");
    expect(parsed.options).toEqual(["有效选项"]);
    expect(parsed.draft).toBeNull();
  });

  it("returns plain text when the envelope is invalid", () => {
    const parsed = parseBuilderAssistantContent("继续补充 Agent 的使用场景。");

    expect(parsed.text).toBe("继续补充 Agent 的使用场景。");
    expect(parsed.options).toEqual([]);
    expect(parsed.draft).toBeNull();
  });
});

describe("BuilderService mock flow", () => {
  it("supports start, option-driven replies, draft creation, and confirmation", async () => {
    const { service, templates } = createBuilderHarness();

    const started = await service.startBuild({ description: "我想创建一个审查 React UI 的 Agent" });
    expect(started.userMessage.content).toBe("我想创建一个审查 React UI 的 Agent");
    expect(started.message.content).not.toContain("\"options\"");
    expect(started.message.options?.length).toBeGreaterThan(0);

    let reply = await service.sendMessage(started.buildId, { message: started.message.options![0] });
    reply = await service.sendMessage(started.buildId, { message: reply.message.options![0] });
    reply = await service.sendMessage(started.buildId, { message: reply.message.options![0] });
    reply = await service.sendMessage(started.buildId, { message: "claude-code" });

    expect(reply.message.content).not.toContain("\"draft\"");
    expect(reply.message.options).toEqual([]);
    expect(reply.message.draft?.name).toBe("Python 数据分析 Agent");
    expect(reply.message.draft?.description).toContain("我想创建一个审查 React UI 的 Agent");
    expect(reply.message.draft?.systemPrompt).toContain("你的职责是");
    expect(reply.message.draft?.systemPrompt).toContain("风格方向");
    expect(reply.message.draft?.defaultProvider).toBe("claude-code");
    expect(reply.context).toMatchObject(reply.message.draft as BuildTemplateDraft);

    const confirmed = await service.confirmBuild(started.buildId, reply.message.draft!);
    expect(confirmed.template.name).toBe("Python 数据分析 Agent");
    expect(templates.create).toHaveBeenCalledWith(reply.message.draft);
  });

  it("lists build sessions with generated titles sorted by update time", async () => {
    const service = createListHarness();

    const result = await service.listSessions();

    expect(result.items.map((item) => item.id)).toEqual(["completed-1", "active-1"]);
    expect(result.items[0]).toMatchObject({
      id: "completed-1",
      status: "completed",
      title: "前端审查 Agent",
      messageCount: 2,
      agentTemplateId: 10,
    });
    expect(result.items[1]).toMatchObject({
      id: "active-1",
      status: "active",
      title: "我想做一个后端 API Agent",
      messageCount: 1,
      agentTemplateId: null,
    });
  });
});

describe("normalizeDraftForConversation", () => {
  it("expands option text instead of reusing it as the final draft", () => {
    const descriptionOption = "使用 Python 进行数据清洗、分析和可视化";
    const promptOption = "严谨分析型：先理解数据结构，再逐步清洗、探索、可视化，每一步给出解释";

    const draft = normalizeDraftForConversation({
      name: "Python 数据分析 Agent",
      description: descriptionOption,
      systemPrompt: promptOption,
      defaultProvider: "claude-code",
    }, [
      { role: "user", content: "我想创建一个 Python 数据分析 Agent" },
      { role: "user", content: "Python 数据分析 Agent" },
      { role: "user", content: descriptionOption },
      { role: "user", content: promptOption },
      { role: "user", content: "claude-code" },
    ]);

    expect(draft.description).not.toBe(descriptionOption);
    expect(draft.description).toContain("我想创建一个 Python 数据分析 Agent");
    expect(draft.systemPrompt).not.toBe(promptOption);
    expect(draft.systemPrompt).toContain("你的职责是");
  });
});

function createBuilderHarness() {
  const now = new Date("2026-05-30T00:00:00.000Z");
  type StoredBuildSession = {
    id: string;
    status: string;
    context: Record<string, unknown>;
    agentTemplateId: number | null;
    createdAt: Date;
    updatedAt: Date;
  };
  type StoredBuildMessage = {
    id: string;
    buildSessionId: string;
    role: string;
    content: string;
    createdAt: Date;
  };
  type CreateMessageInput = {
    data: Omit<StoredBuildMessage, "id" | "createdAt">;
  };

  let session: StoredBuildSession = {
    id: "build-1",
    status: "active",
    context: {},
    agentTemplateId: null,
    createdAt: now,
    updatedAt: now,
  };
  const messages: StoredBuildMessage[] = [];

  const prisma = {
    buildSession: {
      create: vi.fn(async ({ data }: { data: Partial<StoredBuildSession> }) => {
        session = { ...session, ...data };
        return session;
      }),
      findUnique: vi.fn(async () => ({ ...session, messages })),
      update: vi.fn(async ({ data }: { data: Partial<StoredBuildSession> }) => {
        session = { ...session, ...data, updatedAt: data.updatedAt ?? session.updatedAt };
        return session;
      }),
    },
    buildMessage: {
      create: vi.fn(async ({ data }: CreateMessageInput) => {
        const message = {
          id: `msg-${messages.length + 1}`,
          buildSessionId: data.buildSessionId,
          role: data.role,
          content: data.content,
          createdAt: now,
        };
        messages.push(message);
        return message;
      }),
      findMany: vi.fn(async ({ where }: { where: { buildSessionId: string } }) =>
        messages.filter((message) => message.buildSessionId === where.buildSessionId),
      ),
    },
  };

  const templates = {
    create: vi.fn(async (input: BuildTemplateDraft) => ({
      id: 42,
      ...input,
      promptConfig: {},
      defaultCapabilities: [],
      defaultModelConfig: {},
      metadata: {},
      status: "enabled",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })),
  };

  const service = new BuilderService(prisma as any, templates as any);
  (service as any).summaryApiKey = undefined;
  (service as any).summaryBaseUrl = undefined;

  return { service, templates };
}

function createListHarness() {
  const older = new Date("2026-05-29T10:00:00.000Z");
  const newer = new Date("2026-05-30T10:00:00.000Z");
  const prisma = {
    buildSession: {
      findMany: vi.fn(async () => [
        {
          id: "completed-1",
          status: "completed",
          context: {
            name: "前端审查 Agent",
            description: "审查前端代码",
            systemPrompt: "你是前端审查助手",
            defaultProvider: "claude-code",
          },
          agentTemplateId: 10,
          createdAt: older,
          updatedAt: newer,
          messages: [
            { role: "user", content: "我想做一个前端审查 Agent" },
            { role: "assistant", content: "已生成草稿" },
          ],
        },
        {
          id: "active-1",
          status: "active",
          context: {},
          agentTemplateId: null,
          createdAt: older,
          updatedAt: older,
          messages: [{ role: "user", content: "我想做一个后端 API Agent" }],
        },
      ]),
    },
  };

  return new BuilderService(prisma as any, { create: vi.fn() } as any);
}
