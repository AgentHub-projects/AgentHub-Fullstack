import { Inject, Injectable } from "@nestjs/common";
import type {
  BuildMessageDto,
  BuildSessionDto,
  ConfirmBuildRequest,
  ConfirmBuildResponse,
  SendBuildMessageRequest,
  SendBuildMessageResponse,
  StartBuildRequest,
  StartBuildResponse,
} from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import { AgentTemplateService } from "./agent-template.service";

const BUILDER_SYSTEM_PROMPT = [
  "你是一个 Agent 模板创建助手。你的任务是通过多轮对话，帮助用户创建一个新的 Agent 模板。",
  "",
  "你需要逐步收集以下信息：",
  "1. Agent 名称（name）— 简洁明了，如 'Python 数据分析 Agent'",
  "2. Agent 描述（description）— 简明描述它的用途和能力",
  "3. System Prompt（systemPrompt）— 定义 Agent 的行为和回答风格",
  "4. 底层 Provider（defaultProvider）— \"claude-code\" 或 \"open-code\"",
  "",
  "规则：",
  "- 每次只问一个问题，逐步收集",
  "- 如果用户一次性提供了多个字段，接受并确认",
  "- 当所有 4 个字段都收集完毕后，生成一个确认预览：",
  "  用以下 JSON 格式输出最后一条消息：",
  "  ---TEMPLATE_DRAFT---",
  "  { \"name\": \"...\", \"description\": \"...\", \"systemPrompt\": \"...\", \"defaultProvider\": \"claude-code\" }",
  "  ---END_TEMPLATE_DRAFT---",
  "- 在 JSON 前用友好文字总结用户配置的 Agent",
  "- 确保用户明确确认后再结束",
].join("\n");

type CollectedContext = {
  name?: string;
  description?: string;
  systemPrompt?: string;
  defaultProvider?: string;
};

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

  async startBuild(input: StartBuildRequest): Promise<StartBuildResponse> {
    const session = await this.prisma.buildSession.create({
      data: {
        status: "active",
        context: {} as any,
      },
    });

    // Save user message
    await this.prisma.buildMessage.create({
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
      message: toDto(msg),
    };
  }

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
    await this.prisma.buildMessage.create({
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
    const reply = await this.chatLLM(buildId, BUILDER_SYSTEM_PROMPT, history);

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
      message: toDto(msg),
      context: context as Record<string, unknown>,
    };
  }

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
      agentTemplateId: session.agentTemplateId ?? null,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  }

  async getMessages(buildId: string): Promise<BuildMessageDto[]> {
    const messages = await this.prisma.buildMessage.findMany({
      where: { buildSessionId: buildId },
      orderBy: { createdAt: "asc" },
    });
    return messages.map(toDto);
  }

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
        } as any,
        updatedAt: new Date(),
      },
    });

    return { template };
  }

  private extractContext(
    messages: Array<{ role: string; content: string }>,
  ): CollectedContext {
    const ctx: CollectedContext = {};
    const fullText = messages.map((m) => m.content).join("\n");

    // Try to parse ---TEMPLATE_DRAFT--- JSON block
    const draftMatch = fullText.match(
      /---TEMPLATE_DRAFT---\s*([\s\S]*?)---END_TEMPLATE_DRAFT---/,
    );
    if (draftMatch) {
      try {
        const parsed = JSON.parse(draftMatch[1].trim());
        if (parsed.name) ctx.name = parsed.name;
        if (parsed.description) ctx.description = parsed.description;
        if (parsed.systemPrompt) ctx.systemPrompt = parsed.systemPrompt;
        if (typeof parsed.defaultProvider === "string") ctx.defaultProvider = parsed.defaultProvider;
        return ctx;
      } catch {
        // fall through to heuristic extraction
      }
    }

    // Heuristic: extract fields from conversation
    const nameMatch = fullText.match(/(?:名称|名字|叫)\S{0,3}[:：]\s*(.+)/);
    if (nameMatch) ctx.name = nameMatch[1].trim();
    const descMatch = fullText.match(/(?:描述|用途|职责|负责)\S{0,3}[:：]\s*(.+)/);
    if (descMatch) ctx.description = descMatch[1].trim();
    const promptMatch = fullText.match(/(?:system[_ ]?prompt|提示词|行为)\S{0,3}[:：]\s*(.+)/i);
    if (promptMatch) ctx.systemPrompt = promptMatch[1].trim();
    if (fullText.includes("claude-code") || fullText.includes("claude code")) ctx.defaultProvider = "claude-code";
    if (fullText.includes("open-code") || fullText.includes("opencode")) ctx.defaultProvider = "open-code";

    return ctx;
  }

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
      return payload.choices?.[0]?.message?.content ?? this.mockReply(buildId, messages);
    } catch {
      return this.mockReply(buildId, messages);
    }
  }

  private mockReply(
    _buildId: string,
    messages: Array<{ role: string; content: string }>,
  ): string {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content ?? "";

    if (messages.length <= 2) {
      return `好的，我来帮你创建 Agent 模板！请问这个 Agent 叫什么名字？
比如 "Python 数据分析 Agent" 或 "前端 UI 审查 Agent"。`;
    }

    if (messages.length <= 4) {
      return `明白了！请描述一下这个 Agent 的主要用途和能力，它会负责什么工作？`;
    }

    if (messages.length <= 6) {
      return `很好！请告诉我这个 Agent 的 System Prompt（行为提示词），定义它如何回答问题、有什么约束。`;
    }

    if (messages.length <= 8) {
      return `最后，请选择底层 Provider：claude-code 或 open-code。你想用哪个？`;
    }

    return `---TEMPLATE_DRAFT---
{
  "name": "${userText.slice(0, 30) || "新 Agent"}",
  "description": "用户创建的 Agent 模板",
  "systemPrompt": "你是一个有帮助的 AI 助手。",
  "defaultProvider": "claude-code"
}
---END_TEMPLATE_DRAFT---

以上是根据你的需求生成的模板草稿，你可以修改后确认创建。`;
  }
}

function toDto(msg: {
  id: string;
  buildSessionId: string;
  role: string;
  content: string;
  createdAt: Date;
}): BuildMessageDto {
  return {
    id: msg.id,
    buildSessionId: msg.buildSessionId,
    role: msg.role,
    content: msg.content,
    createdAt: msg.createdAt.toISOString(),
  };
}
