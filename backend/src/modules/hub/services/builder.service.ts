import { Inject, Injectable } from "@nestjs/common";
import type {
  BuildMessageDto,
  BuildTemplateDraft,
  BuildSessionDto,
  ListBuildSessionsResponse,
  ConfirmBuildRequest,
  ConfirmBuildResponse,
  SendBuildMessageRequest,
  SendBuildMessageResponse,
  StartBuildRequest,
  StartBuildResponse,
} from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import { AgentTemplateService } from "./agent-template.service";
import { normalizeTools, stringValue } from "../utils/downstream-orchestrator.utils";

const BUILDER_SYSTEM_PROMPT = [
  "你是一个 Agent 模板创建助手。你的任务是通过多轮对话，帮助用户创建一个新的 Agent 模板。",
  "",
  "你需要逐步收集以下信息：",
  "1. Agent 名称（name）— 简洁明了，如 'Python 数据分析 Agent'",
  "2. Agent 描述（description）— 简明描述它的用途和能力",
  "3. System Prompt（systemPrompt）— 定义 Agent 的行为和回答风格",
  "4. 工具集（tools）— 这个 Agent 可以使用的工具标识，如 shell、git、browser、deploy、file-system",
  "5. 底层 Provider（defaultProvider）— \"claude-code\" 或 \"open-code\"",
  "",
  "规则：",
  "- 每次只问一个问题，逐步收集",
  "- 如果用户一次性提供了多个字段，接受并确认",
  "- 只输出一个 JSON 对象，不要输出 Markdown、代码块或额外解释",
  "- JSON 格式固定为：",
  "  { \"text\": \"给用户看的回复\", \"options\": [\"选项1\", \"选项2\"], \"draft\": null }",
  "- 每条提问消息的 options 提供 2~4 个具体、有参考价值的可点击建议",
  "- options 是方向选择，不是最终字段。用户点选后，你必须综合用户第一句话和后续选择生成更完整的 name、description、systemPrompt",
  "- 用户点选某个 option 后，不要说“已定为该选项”。只把它当作偏好或范围，用于下一轮问题和最终草稿生成",
  "- 特别是 systemPrompt 不要直接复用用户点选的短句，要展开为可落地的行为规范、输出要求和边界约束",
  "- tools 必须是字符串数组，允许为空数组，但要优先根据 Agent 职责选择 2~5 个工具标识",
  "- 当所有 5 个字段都收集完毕后，options 必须为空数组，并把 draft 设为：",
  "  { \"name\": \"...\", \"description\": \"...\", \"systemPrompt\": \"...\", \"defaultProvider\": \"claude-code\", \"tools\": [\"shell\", \"git\"] }",
  "- defaultProvider 只能是 \"claude-code\" 或 \"open-code\"",
].join("\n");

type CollectedContext = {
  name?: string;
  description?: string;
  systemPrompt?: string;
  defaultProvider?: string;
  tools?: string[];
};

export type BuilderAssistantContent = {
  text: string;
  options: string[];
  draft: BuildTemplateDraft | null;
};

/** Agent 模板构建器：通过多轮 LLM 对话引导用户创建 Agent 模板，支持 mock 回退 */
@Injectable()
export class BuilderService {
  private readonly summaryApiKey = process.env.SUMMARY_API_KEY ?? process.env.OPENAI_API_KEY;
  private readonly summaryBaseUrl = (
    process.env.SUMMARY_BASE_URL ?? process.env.OPENAI_COMPATIBLE_BASE_URL ?? process.env.OPENAI_BASE_URL
  )?.replace(/\/$/, "");
  private readonly summaryModel = process.env.CONTEXT_SUMMARY_MODEL ?? "deepseek-chat";

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AgentTemplateService) private readonly templates: AgentTemplateService,
  ) {}

  /** 列出最近的构建会话（最多 50 个） */
  async listSessions(): Promise<ListBuildSessionsResponse> {
    const sessions = await this.prisma.buildSession.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          select: { role: true, content: true },
        },
      },
    });

    return {
      items: sessions.map((session) => ({
        id: session.id,
        status: session.status,
        title: buildSessionTitle(
          session.status,
          session.context as Record<string, unknown>,
          session.messages,
        ),
        messageCount: session.messages.length,
        agentTemplateId: session.agentTemplateId != null ? Number(session.agentTemplateId) : null,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
      })),
    };
  }

  /** 开始新的构建会话：保存用户消息，调用 LLM 获取首次回复 */
  async startBuild(input: StartBuildRequest): Promise<StartBuildResponse> {
    const session = await this.prisma.buildSession.create({
      data: {
        status: "active",
        context: {} as any,
      },
    });

    // Save user message
    const userMsg = await this.prisma.buildMessage.create({
      data: {
        buildSessionId: session.id,
        role: "user",
        content: input.description,
      },
    });

    // Call LLM for first response
    const reply = await this.chatLLM(session.id, BUILDER_SYSTEM_PROMPT, [
      { role: "user", content: input.description },
    ]);

    const msg = await this.prisma.buildMessage.create({
      data: {
        buildSessionId: session.id,
        role: "assistant",
        content: reply,
      },
    });

    return {
      buildId: session.id,
      userMessage: toDto(userMsg),
      message: toDto(msg),
    };
  }

  /** 发送构建消息并获取 LLM 回复，提取上下文更新会话 */
  async sendMessage(
    buildId: string,
    input: SendBuildMessageRequest,
  ): Promise<SendBuildMessageResponse> {
    const session = await this.prisma.buildSession.findUnique({
      where: { id: buildId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!session || session.status !== "active") {
      throw new Error("Build session not found or already completed");
    }

    // Save user message
    const userMsg = await this.prisma.buildMessage.create({
      data: {
        buildSessionId: buildId,
        role: "user",
        content: input.message,
      },
    });

    // Build conversation history
    const messages = await this.prisma.buildMessage.findMany({
      where: { buildSessionId: buildId },
      orderBy: { createdAt: "asc" },
    });
    const history = messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // Call LLM
    const rawReply = await this.chatLLM(buildId, BUILDER_SYSTEM_PROMPT, history);
    const reply = normalizeBuilderAssistantReply(rawReply, messages);

    const msg = await this.prisma.buildMessage.create({
      data: {
        buildSessionId: buildId,
        role: "assistant",
        content: reply,
      },
    });

    // Try to extract collected fields from the conversation
    const context = this.extractContext(messages.concat(msg));

    await this.prisma.buildSession.update({
      where: { id: buildId },
      data: { context: context as any, updatedAt: new Date() },
    });

    return {
      userMessage: toDto(userMsg),
      message: toDto(msg),
      context: context as Record<string, unknown>,
    };
  }

  /** 获取构建会话详情 */
  async getSession(buildId: string): Promise<BuildSessionDto> {
    const session = await this.prisma.buildSession.findUnique({
      where: { id: buildId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!session) throw new Error("Build session not found");
    return {
      id: session.id,
      status: session.status,
      context: session.context as Record<string, unknown>,
      agentTemplateId: session.agentTemplateId != null ? Number(session.agentTemplateId) : null,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  }

  /** 获取构建会话的所有消息 */
  async getMessages(buildId: string): Promise<BuildMessageDto[]> {
    const messages = await this.prisma.buildMessage.findMany({
      where: { buildSessionId: buildId },
      orderBy: { createdAt: "asc" },
    });
    return messages.map(toDto);
  }

  /** 确认构建结果：调用 AgentTemplateService 创建模板，标记会话为完成 */
  async confirmBuild(
    buildId: string,
    input: ConfirmBuildRequest,
  ): Promise<ConfirmBuildResponse> {
    const session = await this.prisma.buildSession.findUnique({ where: { id: buildId } });
    if (!session || session.status !== "active") {
      throw new Error("Build session not found or already completed");
    }

    // Create the template
    const template = await this.templates.create({
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      defaultProvider: input.defaultProvider,
      tools: input.tools ?? [],
    });

    // Mark session as completed
    await this.prisma.buildSession.update({
      where: { id: buildId },
      data: {
        status: "completed",
        agentTemplateId: template.id,
        context: {
          name: input.name,
          description: input.description,
          systemPrompt: input.systemPrompt,
          defaultProvider: input.defaultProvider,
          tools: input.tools ?? [],
        } as any,
        updatedAt: new Date(),
      },
    });

    return { template };
  }

  /** 从对话中提取收集到的模板字段（优先使用 draft，回退到启发式正则） */
  private extractContext(
    messages: Array<{ role: string; content: string }>,
  ): CollectedContext {
    const ctx: CollectedContext = {};
    for (const message of [...messages].reverse()) {
      if (message.role !== "assistant") continue;
      const draft = parseBuilderAssistantContent(message.content).draft;
      if (draft) {
        ctx.name = draft.name;
        ctx.description = draft.description;
        ctx.systemPrompt = draft.systemPrompt;
        ctx.defaultProvider = draft.defaultProvider;
        ctx.tools = draft.tools;
        return ctx;
      }
    }

    // Heuristic: extract fields from conversation
    const fullText = messages.map((m) => m.content).join("\n");
    const nameMatch = fullText.match(/(?:名称|名字|叫)\S{0,3}[:：]\s*(.+)/);
    if (nameMatch) ctx.name = nameMatch[1].trim();
    const descMatch = fullText.match(/(?:描述|用途|职责|负责)\S{0,3}[:：]\s*(.+)/);
    if (descMatch) ctx.description = descMatch[1].trim();
    const promptMatch = fullText.match(/(?:system[_ ]?prompt|提示词|行为)\S{0,3}[:：]\s*(.+)/i);
    if (promptMatch) ctx.systemPrompt = promptMatch[1].trim();
    const toolsMatch = fullText.match(/(?:tools?|工具集?|工具)\S{0,3}[:：]\s*(.+)/i);
    if (toolsMatch) ctx.tools = parseToolList(toolsMatch[1]);
    if (fullText.includes("claude-code") || fullText.includes("claude code")) ctx.defaultProvider = "claude-code";
    if (fullText.includes("open-code") || fullText.includes("opencode")) ctx.defaultProvider = "open-code";

    return ctx;
  }

  /** 调用 OpenAI 兼容的 LLM API，失败时回退到 mockReply */
  private async chatLLM(
    buildId: string,
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    if (!this.summaryApiKey || !this.summaryBaseUrl) {
      // Fallback: simple mock
      return this.mockReply(buildId, messages);
    }

    try {
      const response = await fetch(`${this.summaryBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.summaryApiKey}`,
        },
        body: JSON.stringify({
          model: this.summaryModel,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages,
          ],
          max_tokens: 1024,
          temperature: 0.7,
        }),
      });

      if (!response.ok) return this.mockReply(buildId, messages);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content?.trim();
      return content || this.mockReply(buildId, messages);
    } catch {
      return this.mockReply(buildId, messages);
    }
  }

  /** Mock LLM 回复：根据对话轮数逐步引导收集模板信息 */
  private mockReply(
    _buildId: string,
    messages: Array<{ role: string; content: string }>,
  ): string {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content ?? "";

    if (messages.length <= 2) {
      return JSON.stringify({
        text: '好的，我来帮你创建 Agent 模板！请问这个 Agent 叫什么名字？比如 "Python 数据分析 Agent" 或 "前端 UI 审查 Agent"。',
        options: ["Python 数据分析 Agent", "前端 UI 审查 Agent", "后端 API 开发 Agent", "DevOps 部署 Agent"],
        draft: null,
      });
    }

    if (messages.length <= 4) {
      return JSON.stringify({
        text: "明白了！请描述一下这个 Agent 的主要用途和能力，它会负责什么工作？",
        options: ["编写和审查 Python 代码", "审查前端组件和样式", "管理后端 API 和数据模型", "处理 CI/CD 和部署流程"],
        draft: null,
      });
    }

    if (messages.length <= 6) {
      return JSON.stringify({
        text: "很好！请告诉我这个 Agent 的 System Prompt（行为提示词），定义它如何回答问题、有什么约束。",
        options: [
          "你是一个专业的技术专家，回答应该准确、详细。使用中文回复。",
          "你是一个高效的代码助手，回答应该简洁、直接。优先给出可执行的代码。",
          "你是一个架构顾问，帮助设计系统架构和最佳实践。用结构化方式回答。",
        ],
        draft: null,
      });
    }

    if (messages.length <= 8) {
      return JSON.stringify({
        text: "这个 Agent 需要哪些工具？请选择或输入工具标识，多个工具可以用逗号分隔。",
        options: ["shell, git, file-system", "browser, fetch, file-system", "deploy, git, shell", "none"],
        draft: null,
      });
    }

    if (messages.length <= 10) {
      return JSON.stringify({
        text: "最后，请选择底层 Provider：claude-code 或 open-code。你想用哪个？",
        options: ["claude-code", "open-code"],
        draft: null,
      });
    }

    const draft = buildMockDraft(messages);
    return JSON.stringify({
      text: "以上是根据你的需求生成的模板草稿，确认后即可创建。",
      options: [],
      draft,
    });
  }
}

/** 解析构建助手回复 JSON 为 BuilderAssistantContent */
export function parseBuilderAssistantContent(content: string): BuilderAssistantContent {
  try {
    const parsed = JSON.parse(content.trim()) as Record<string, unknown>;
    return {
      text: (stringValue(parsed.text) ?? "") || content.trim(),
      options: optionsValue(parsed.options),
      draft: draftValue(parsed.draft),
    };
  } catch {
    return { text: content.trim(), options: [], draft: null };
  }
}

/** 标准化构建助手回复，如果包含 draft 则用对话上下文丰富 */
export function normalizeBuilderAssistantReply(
  content: string,
  messages: Array<{ role: string; content: string }>,
) {
  const parsed = parseBuilderAssistantContent(content);
  if (!parsed.draft) return content;

  return JSON.stringify({
    text: parsed.text || "以上是根据你的需求生成的模板草稿，确认后即可创建。",
    options: parsed.options,
    draft: normalizeDraftForConversation(parsed.draft, messages),
  });
}

/** 根据对话上下文增强 draft 草稿的字段 */
export function normalizeDraftForConversation(
  draft: BuildTemplateDraft,
  messages: Array<{ role: string; content: string }>,
): BuildTemplateDraft {
  const userMessages = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean);
  const initialNeed = userMessages[0] || draft.name;
  const selectedName = userMessages[1] || draft.name;
  const selectedDescription = userMessages[2] || draft.description;
  const selectedPromptDirection = userMessages[3] || draft.systemPrompt;
  const selectedTools = parseToolList(userMessages[4] || "");

  const description = isDirectOptionReuse(draft.description, userMessages)
    ? buildMockDescription(initialNeed, selectedDescription)
    : draft.description;
  const systemPrompt = isDirectOptionReuse(draft.systemPrompt, userMessages) || draft.systemPrompt.length < 80
    ? buildMockSystemPrompt(selectedName, description, selectedPromptDirection)
    : draft.systemPrompt;

  return {
    name: draft.name || deriveMockName(selectedName),
    description,
    systemPrompt,
    defaultProvider: draft.defaultProvider === "open-code" ? "open-code" : "claude-code",
    tools: selectedTools.length ? selectedTools : normalizeTools(draft.tools),
  };
}

function optionsValue(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function draftValue(value: unknown): BuildTemplateDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const draft = {
    name: stringValue(record.name) ?? "",
    description: stringValue(record.description) ?? "",
    systemPrompt: stringValue(record.systemPrompt) ?? "",
    defaultProvider: stringValue(record.defaultProvider) ?? "",
    tools: normalizeTools(record.tools),
  };
  return draft.name && draft.description && draft.systemPrompt && draft.defaultProvider
    ? draft
    : null;
}

function isDirectOptionReuse(value: string, userMessages: string[]) {
  const normalized = compactComparable(value);
  if (!normalized) return false;
  return userMessages
    .slice(1)
    .filter((message) => message !== "claude-code" && message !== "open-code")
    .some((message) => compactComparable(message) === normalized);
}

function compactComparable(value: string) {
  return value.replace(/\s+/g, "").replace(/[。.!！?？,，;；:："'“”‘’]/g, "").toLowerCase();
}

function buildMockDraft(messages: Array<{ role: string; content: string }>): BuildTemplateDraft {
  const userMessages = messages.filter((message) => message.role === "user").map((message) => message.content.trim());
  const initialNeed = userMessages[0] || "自定义 Agent";
  const selectedName = userMessages[1] || deriveMockName(initialNeed);
  const selectedDescription = userMessages[2] || "协助完成用户指定的专业任务";
  const selectedPromptDirection = userMessages[3] || "专业、准确、结构化地回答";
  const selectedTools = parseToolList(userMessages[4] || "");
  const providerChoice = [...userMessages].reverse().find((message) =>
    message === "claude-code" || message === "open-code" || /claude|open.?code/i.test(message)
  );

  return {
    name: deriveMockName(selectedName),
    description: buildMockDescription(initialNeed, selectedDescription),
    systemPrompt: buildMockSystemPrompt(selectedName, selectedDescription, selectedPromptDirection),
    defaultProvider: providerChoice?.includes("open") ? "open-code" : "claude-code",
    tools: selectedTools,
  };
}

function parseToolList(value: string) {
  const normalized = value.trim();
  if (!normalized || /^(none|无|不需要|claude-code|open-code)$/i.test(normalized)) return [];
  return normalizeTools(normalized.split(/[,，、\n]/).filter((item) => !/^(claude-code|open-code)$/i.test(item.trim())));
}

function deriveMockName(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "新 Agent";
  if (normalized.length <= 28 && /Agent|助手|专家|审查|开发|分析/i.test(normalized)) return normalized;
  return `${normalized.slice(0, 20)} Agent`;
}

function buildMockDescription(initialNeed: string, selectedDescription: string) {
  return `根据用户需求“${initialNeed.slice(0, 48)}”，负责${selectedDescription.replace(/[。.]$/, "")}，并在对话中给出可执行、可验证的结果。`;
}

function buildMockSystemPrompt(name: string, description: string, direction: string) {
  return [
    `你是 ${deriveMockName(name)}。`,
    `你的职责是${description.replace(/[。.]$/, "")}。`,
    `回答时要结合用户目标主动澄清关键缺口，优先给出可执行方案、必要步骤和验收标准。`,
    `风格方向：${direction.replace(/[。.]$/, "")}。不要只给泛泛建议，涉及代码或配置时要指出关键文件、命令或风险。`,
    `如果信息不足，先说明假设；如果任务超出能力边界，明确指出限制并给出替代路径。`,
  ].join("\n");
}

function buildSessionTitle(
  status: string,
  context: Record<string, unknown>,
  messages: Array<{ role: string; content: string }>,
) {
  const completedName = status === "completed" ? (stringValue(context.name) ?? "") : "";
  if (completedName) return compactTitle(completedName);

  const firstUser = messages.find((message) => message.role === "user");
  if (firstUser?.content) return compactTitle(firstUser.content);

  return "新 Agent 模板创建";
}

function compactTitle(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 36 ? `${normalized.slice(0, 36)}...` : normalized;
}

function toDto(msg: {
  id: string;
  buildSessionId: string;
  role: string;
  content: string;
  createdAt: Date;
}): BuildMessageDto {
  const parsed = msg.role === "assistant"
    ? parseBuilderAssistantContent(msg.content)
    : null;
  return {
    id: msg.id,
    buildSessionId: msg.buildSessionId,
    role: msg.role,
    content: parsed?.text ?? msg.content,
    ...(parsed && { options: parsed.options, draft: parsed.draft }),
    createdAt: msg.createdAt.toISOString(),
  };
}
