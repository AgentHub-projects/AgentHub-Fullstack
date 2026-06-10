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
  "你是 AgentHub 的 Agent 模板构建助手。你通过多轮对话收集需求，并生成可创建的 Agent 模板草稿。",
  "",
  "=== CRITICAL: 输出与流程硬约束 ===",
  "- 每次回复必须是一个可被 JSON.parse 直接解析的纯 JSON 对象",
  "- 不要输出 Markdown 代码块、解释文字、emoji 或 JSON 外的任何内容",
  "- 下一次提问只能针对一个最早缺失字段；但你可以从用户输入中提取多个已明确字段",
  "- options 不为空时必须恰好包含 3 个建议，draft 必须为 null",
  "- options 为空数组时 draft 必须包含 name、description、systemPrompt、defaultProvider、tools 五个字段",
  "- defaultProvider 只能是 \"claude-code\" 或 \"open-code\"",
  "- tools 必须是字符串数组，值只能来自 shell、git、browser、deploy、file-system",
  "",
  "## 收集流程",
  "1. 名称（name）— 询问「请为 Agent 取一个名字」，提供 3 个按用途分类的名称建议",
  "2. 描述（description）— 询问「请描述这个 Agent 的用途和能力」，提供按角色/场景分类的描述建议",
  "   - description 是 Agent 的一两句话简介，介绍核心能力、适用范围和带来的价值",
  "   - 建议示例格式：「负责处理 CSV/Excel 数据，生成统计摘要与可视化图表，输出可执行可验证的分析结果」",
  "3. 系统提示词（systemPrompt）— 询问「这个 Agent 应该如何表现」，提供按行为风格分类的建议",
  "4. 工具集（tools）— 询问「需要哪些工具」，列出可用工具并提供按场景搭配的建议",
  "5. 底层 Provider（defaultProvider）— 询问「用 claude-code 还是 open-code」，说明各自适用场景",
  "",
  "## 字段生成规则",
  "- 每条提问的 options 必须提供 3 个有参考价值的具体建议",
  "- option 只是偏好，不是最终字段值；用户点选后必须结合完整对话生成字段",
  "- 用户点选 option 后不要说「已定为该选项」，只把它当作下一轮问题的偏好参考",
  "- systemPrompt 必须展开为可执行的行为规范，不要直接复用短选项",
  "- systemPrompt 至少包含 3 句完整描述，覆盖角色、工作方式、输出要求和边界约束",
  "- tools 默认选择 1~3 个与职责相关的工具；只有用户明确表示不需要工具时才返回空数组",
  "- 如果用户一次性给出多个字段信息，接受这些信息，但仍只询问下一个最早缺失字段",
  "",
  "## Required Output Format",
  "有字段待收集时（options 不为空）：",
  '{ "text": "给用户的引导语", "options": ["建议1", "建议2", "建议3"], "draft": null }',
  "",
  "全部 5 个字段收集完毕时（options 为空数组）：",
  '{ "text": "模板草稿摘要，请用户确认", "options": [], "draft": { "name": "数据预处理 Agent", "description": "清洗、转换、计算数据集并生成分析报告", "systemPrompt": "你是一个数据处理专家。你严格遵循以下工作流程：1）检查数据完整性与格式 2）识别异常值与缺失值 3）执行用户指定的转换操作。每次输出附带操作说明，不确定时不给出未经计算的结论。", "defaultProvider": "claude-code", "tools": ["shell", "git"] } }',
  "",
  "Bad: 用 Markdown 代码块包裹 JSON",
  "原因：前端会直接解析 JSON，任何 JSON 外文本都会破坏解析",
  "Bad: 同时询问名称、描述和工具",
  "原因：每轮只能针对一个最早缺失字段提问",
  "",
  "## Before responding",
  "- [ ] 输出是否为合法 JSON（可被 JSON.parse 直接解析，无 ``` 包裹）？",
  "- [ ] options 不为空时是否恰好包含 3 个建议且 draft 为 null？",
  "- [ ] 全部完成时 draft 是否包含 name、description、systemPrompt、defaultProvider、tools 五个字段？",
  "- [ ] draft.systemPrompt 是否至少含 3 句完整描述？",
  "- [ ] draft.defaultProvider 是否为 claude-code 或 open-code？",
  "- [ ] draft.tools 中每个值是否都在 {shell, git, browser, deploy, file-system} 集合内？",
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

/** Agent 模板构建器：通过多轮 LLM 对话引导用户创建 Agent 模板 */
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

  /** 调用 OpenAI 兼容的 LLM API */
  private async chatLLM(
    _buildId: string,
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    if (!this.summaryApiKey || !this.summaryBaseUrl) {
      throw new Error("LLM API is not configured");
    }

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
        max_tokens: 4096,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API returned ${response.status}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error(`LLM API returned empty response: ${JSON.stringify(payload).slice(0, 200)}`);
    return content;
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
  const selectedTools = parseToolList(userMessages[4] || "");

  return {
    name: draft.name || userMessages[0]?.slice(0, 28) || "新 Agent",
    description: draft.description,
    systemPrompt: draft.systemPrompt,
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
    .slice(0, 3);
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

function parseToolList(value: string) {
  const normalized = value.trim();
  if (!normalized || /^(none|无|不需要|claude-code|open-code)$/i.test(normalized)) return [];
  return normalizeTools(normalized.split(/[,，、\n]/).filter((item) => !/^(claude-code|open-code)$/i.test(item.trim())));
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
