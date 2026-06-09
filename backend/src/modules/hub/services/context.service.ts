import { Inject, Injectable } from "@nestjs/common";
import type {
  AgentInstanceDto,
  ContextSnapshotItem,
  ContextSnapshotPayload,
  HubContextSnapshotDto,
  HubContextItemKind,
  SessionMemoryDto,
  SessionMemoryFileEntry,
  SessionMemoryErrorEntry,
  SessionMemoryWorkLogEntry,
} from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import { mapContextSnapshot } from "../mappers/hub.mappers";

type ContextRow = {
  id: string;
  kind: HubContextItemKind | string;
  text: string;
  tokenCount: number;
  importance: number;
  pinned: boolean;
  createdAt: Date;
};

// Short-term summary buffer (P0: in-memory; P1: Redis)
const shortTermBuffers = new Map<string, { events: string[]; tokenCount: number }>();

const SHORT_TERM_EVENT_LIMIT = 20;
const SHORT_TERM_TOKEN_LIMIT = 2000;
const PINNED_PART_TEXT_LIMIT = 20_000;
const RECENT_CODE_PART_LIMIT = 3;
const RECENT_CODE_PART_TEXT_LIMIT = 2_000;

/** 上下文服务：管理会话上下文记忆，包括短期缓冲压缩、向量召回、快照构建 */
@Injectable()
export class HubContextService {
  private readonly tokenBudget = Number(process.env.CONTEXT_TOKEN_BUDGET ?? 9000);
  private readonly recentTokenBudget = Number(process.env.CONTEXT_RECENT_TOKEN_BUDGET ?? 4800);
  private readonly retrievalLimit = Number(process.env.CONTEXT_RETRIEVAL_LIMIT ?? 8);
  private readonly embeddingModel = process.env.CONTEXT_EMBEDDING_MODEL ?? "text-embedding-3-small";
  private readonly summaryModel = process.env.CONTEXT_SUMMARY_MODEL ?? "deepseek-chat";
  private readonly summaryApiKey = process.env.SUMMARY_API_KEY ?? process.env.OPENAI_API_KEY;
  private readonly summaryBaseUrl = (process.env.SUMMARY_BASE_URL ?? process.env.OPENAI_COMPATIBLE_BASE_URL ?? process.env.OPENAI_BASE_URL)?.replace(/\/$/, "");

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 粗略估算 token 数量：字符数 / 4 */
  estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }

  /** 记录一条上下文条目：持久化、存储嵌入向量、追加到短期缓冲 */
  async recordContextItem(input: {
    sessionId: string;
    sourceType: string;
    sourceId?: string;
    kind: HubContextItemKind;
    text: string;
    pinned?: boolean;
    importance?: number;
    metadata?: Record<string, unknown>;
  }) {
    const item = await this.prisma.contextItem.create({
      data: {
        sessionId: input.sessionId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        kind: input.kind,
        text: input.text,
        tokenCount: this.estimateTokens(input.text),
        pinned: input.pinned ?? false,
        importance: input.importance ?? 0,
        metadata: (input.metadata ?? {}) as any,
      },
    });
    await this.persistEmbedding(item.id, input.sessionId, input.text);
    await this.appendShortTermBuffer(input.sessionId, `${input.kind}: ${input.text}`);
    return item;
  }

  /** 设置消息的置顶状态 */
  async setMessagePinned(sessionId: string, messageId: string, pinned: boolean) {
    const message = await this.prisma.message.update({
      where: { id: messageId },
      data: { isPinned: pinned },
    });

    const existing = await this.prisma.contextItem.findFirst({
      where: { sessionId, sourceType: "message", sourceId: messageId },
    });
    if (existing) {
      await this.prisma.contextItem.update({
        where: { id: existing.id },
        data: { pinned },
      });
    } else {
      await this.recordContextItem({
        sessionId,
        sourceType: "message",
        sourceId: messageId,
        kind: pinned ? "manual_pin" : "message",
        text: message.contentText,
        pinned,
        importance: pinned ? 100 : 0,
      });
    }
    return message;
  }

  /** 设置消息部件的置顶状态 */
  async setMessagePartPinned(sessionId: string, messageId: string, partId: string, pinned: boolean) {
    const message = await this.prisma.message.findFirst({ where: { id: messageId, sessionId } });
    if (!message) throw new Error("Message not found");
    const contentJson = objectValue(message.contentJson);
    const parts = Array.isArray(contentJson.parts) ? contentJson.parts : [];
    const part = parts.find((item) => objectValue(item).id === partId);
    if (!part) throw new Error("Message part not found");
    const partObject = objectValue(part);
    const text = partText(partObject);

    const existing = await this.prisma.contextItem.findMany({
      where: { sessionId, sourceType: "message_part", sourceId: messageId },
    });
    for (const item of existing) {
      if (objectValue(item.metadata).partId === partId) {
        await this.prisma.contextItem.update({ where: { id: item.id }, data: { pinned } });
      }
    }
    if (pinned && !existing.some((item) => objectValue(item.metadata).partId === partId)) {
      await this.recordContextItem({
        sessionId,
        sourceType: "message_part",
        sourceId: messageId,
        kind: "manual_pin",
        text,
        pinned: true,
        importance: 100,
        metadata: { messageId, partId, partType: partObject.type },
      });
    }

    const pinnedPartIds = new Set(
      Array.isArray(contentJson.pinnedPartIds)
        ? contentJson.pinnedPartIds.filter((item): item is string => typeof item === "string")
        : [],
    );
    if (pinned) pinnedPartIds.add(partId);
    else pinnedPartIds.delete(partId);
    return this.prisma.message.update({
      where: { id: messageId },
      data: { contentJson: { ...contentJson, pinnedPartIds: [...pinnedPartIds] } as any },
    });
  }

  /** 构建上下文快照：收集置顶、近期消息、向量召回和摘要，按 token 预算裁剪 */
  async buildSnapshot(input: {
    sessionId: string;
    runId?: string;
    promptText: string;
    mentionedAgents: AgentInstanceDto[];
  }): Promise<HubContextSnapshotDto> {
    await this.prisma.contextUpdateJob.create({
      data: { sessionId: input.sessionId, reason: "build_snapshot", status: "running", startedAt: new Date() },
    });

    const pinned = await this.prisma.contextItem.findMany({
      where: { sessionId: input.sessionId, pinned: true },
      orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
      take: 20,
    });

    const recentMessages = await this.prisma.message.findMany({
      where: { sessionId: input.sessionId },
      orderBy: { createdAt: "desc" },
      take: 24,
    });

    const retrievedRows = await this.recallByPgvector(input.sessionId, input.promptText, this.retrievalLimit);
    const memorySummary = await this.loadSessionMemorySummary(input.sessionId);

    const selectedIds = new Set<string>();
    let total = 0;
    const pins = this.selectWithinBudget(
      pinned.map(toItem),
      this.tokenBudget,
      selectedIds,
      (count) => { total += count; },
    );

    const recent = this.selectWithinBudget(
      recentMessages
        .reverse()
        .map((message) => {
          const text = snapshotMessageContextText(message);
          return {
            id: message.id,
            kind: "message" as const,
            text,
            tokenCount: this.estimateTokens(text),
            importance: message.isPinned ? 100 : 0,
            pinned: message.isPinned,
            createdAt: message.createdAt.toISOString(),
          };
        }),
      this.recentTokenBudget,
      selectedIds,
      (count) => { total += count; },
    );

    const remainingBudget = Math.max(1000, this.tokenBudget - total);
    const retrieved = this.selectWithinBudget(
      retrievedRows.map(toItem),
      remainingBudget,
      selectedIds,
      (count) => { total += count; },
    );

    const payload: ContextSnapshotPayload = {
      pins,
      recent,
      retrieved,
      summary: memorySummary || "",
      mentionedAgents: input.mentionedAgents.map((agent) => ({ id: agent.id, name: agent.name })),
    };

    const promptText = renderContextPrompt(payload);
    const snapshot = await this.prisma.contextSnapshot.create({
      data: {
        sessionId: input.sessionId,
        runId: input.runId,
        tokenBudget: this.tokenBudget,
        tokenCount: total + this.estimateTokens(memorySummary || ""),
        selectedItemIds: [...selectedIds],
        snapshotJson: payload as any,
        promptText,
      },
    });

    await this.prisma.contextUpdateJob.updateMany({
      where: { sessionId: input.sessionId, reason: "build_snapshot", status: "running" },
      data: { status: "completed", completedAt: new Date() },
    });

    return mapContextSnapshot(snapshot);
  }

  // ---- Session Memory ----

  /** 加载 Session Memory 并渲染为纯文本摘要 */
  async loadSessionMemorySummary(sessionId: string): Promise<string> {
    const memory = await this.prisma.sessionMemory.findUnique({ where: { sessionId } });
    if (!memory) return "";
    return renderMemorySummary(memory as unknown as SessionMemoryDto);
  }

  // ---- Incremental Summary Chain ----

  /** 追加文本到短期缓冲，达到限制时触发压缩 */
  private async appendShortTermBuffer(sessionId: string, text: string) {
    let buffer = shortTermBuffers.get(sessionId);
    if (!buffer) {
      buffer = { events: [], tokenCount: 0 };
      shortTermBuffers.set(sessionId, buffer);
    }

    buffer.events.push(text);
    buffer.tokenCount += this.estimateTokens(text);

    if (buffer.events.length >= SHORT_TERM_EVENT_LIMIT || buffer.tokenCount >= SHORT_TERM_TOKEN_LIMIT) {
      await this.buildSessionMemory(sessionId, buffer);
    }
  }

  /** 构建 Session Memory：调用 LLM 结构化提取，upsert 合并到 sessionMemory 表 */
  private async buildSessionMemory(
    sessionId: string,
    buffer: { events: string[]; tokenCount: number },
  ) {
    const text = buffer.events.join("\n");
    const structured = await this.invokeStructuredMemoryLLM(text);

    // Read existing record
    const existing = await this.prisma.sessionMemory.findUnique({ where: { sessionId } });

    // Merge: title/status/lessons overwrite; files/errors/workLog merge with dedup
    const existingFiles: SessionMemoryFileEntry[] = (existing?.files as unknown as SessionMemoryFileEntry[]) ?? [];
    const existingErrors: SessionMemoryErrorEntry[] = (existing?.errors as unknown as SessionMemoryErrorEntry[]) ?? [];
    const existingWorkLog: SessionMemoryWorkLogEntry[] = (existing?.workLog as unknown as SessionMemoryWorkLogEntry[]) ?? [];

    const mergedFiles = mergeByPath(existingFiles, structured.files ?? []);
    const mergedErrors = mergeByMessage(existingErrors, structured.errors ?? []);
    const mergedWorkLog = [...(structured.workLog ?? []), ...existingWorkLog].slice(0, 20);

    await this.prisma.sessionMemory.upsert({
      where: { sessionId },
      create: {
        sessionId,
        title: structured.title ?? existing?.title ?? null,
        status: structured.status ?? existing?.status ?? null,
        files: mergedFiles as any,
        errors: mergedErrors as any,
        lessons: structured.lessons ?? existing?.lessons ?? null,
        workLog: mergedWorkLog as any,
        version: (existing?.version ?? 0) + 1,
      },
      update: {
        title: structured.title ?? existing?.title ?? null,
        status: structured.status ?? existing?.status ?? null,
        files: mergedFiles as any,
        errors: mergedErrors as any,
        lessons: structured.lessons ?? existing?.lessons ?? null,
        workLog: mergedWorkLog as any,
        version: (existing?.version ?? 0) + 1,
      },
    });

    // Reset short-term buffer
    buffer.events = [];
    buffer.tokenCount = 0;
  }

  /** 调用 LLM 从短期缓冲提取结构化 Session Memory */
  private async invokeStructuredMemoryLLM(text: string): Promise<{
    title?: string;
    status?: string;
    files?: SessionMemoryFileEntry[];
    errors?: SessionMemoryErrorEntry[];
    lessons?: string | null;
    workLog?: SessionMemoryWorkLogEntry[];
  }> {
    if (!this.summaryApiKey || !this.summaryBaseUrl) {
      // Fallback: return minimal structure
      return { title: text.slice(0, 200) };
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
            {
              role: "system",
              content: [
                "你是 AgentHub 工作记录分析器。你只根据本轮 Agent 工作日志提取结构化增量记忆。",
                "",
                "=== CRITICAL: 增量提取约束 ===",
                "- 只输出纯 JSON 对象，不要 Markdown 代码块或解释文字",
                "- 输入只包含本轮日志，不包含完整历史；不要猜测历史状态",
                "- title、status、lessons 只有在本轮日志提供明确新信息时填写；否则返回 null",
                "- files、errors、workLog 只返回本轮新出现的内容；没有新内容时返回空数组",
                "- 所有字段键名必须固定存在，但不要用空字符串、\"无\"、\"不变\"、\"null\" 字符串凑字段",
                "- 不要编造文件路径、错误、解决方案或时间",
                "",
                "## Required Output Format",
                "{",
                '  "title": null,',
                '  "status": null,',
                '  "files": [],',
                '  "errors": [],',
                '  "lessons": null,',
                '  "workLog": []',
                "}",
                "",
                'Good: {"title":null,"status":null,"files":[{"path":"backend/src/a.ts","description":"修复解析逻辑","changeType":"modified"}],"errors":[],"lessons":null,"workLog":[{"timestamp":"2026-06-08T10:00:00.000Z","summary":"修复上下文解析逻辑"}]}',
                'Bad: {"title":"不变","status":"进行中","files":[],"errors":[],"lessons":"无","workLog":[]}',
                "原因：使用占位文本，并且在没有明确新信息时覆盖 title/status",
                "",
                "## Before responding",
                "- [ ] JSON 是否合法可解析（非截断、非空、无语法错误）？",
                "- [ ] 输出是否不含 ``` 字符？",
                "- [ ] 无新 title/status/lessons 时是否返回 null？",
                "- [ ] 无新 files/errors/workLog 时是否返回空数组？",
              ].join("\n"),
            },
            { role: "user", content: text.slice(0, 8000) },
          ],
          max_tokens: 800,
          temperature: 0.3,
        }),
      });

      if (!response.ok) return { title: text.slice(0, 200) };
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = payload.choices?.[0]?.message?.content;
      if (!raw) return { title: text.slice(0, 200) };

      // Extract JSON from potential markdown wrapping
      const jsonStr = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      try {
        return JSON.parse(jsonStr);
      } catch {
        // If JSON parsing fails, treat output as plain title
        return { title: raw.slice(0, 200) };
      }
    } catch {
      return { title: text.slice(0, 200) };
    }
  }

  /** 获取下一个长期摘要序号 */

  // ---- Embedding & Vector Recall ----

  /** 从候选项中按 token 预算贪婪选择条目 */
  private selectWithinBudget(
    items: ContextSnapshotItem[],
    budget: number,
    selectedIds: Set<string>,
    onSelect: (tokenCount: number) => void,
  ): ContextSnapshotItem[] {
    const result: ContextSnapshotItem[] = [];
    let used = 0;
    for (const item of items) {
      if (selectedIds.has(item.id)) continue;
      if (used + item.tokenCount > budget) continue;
      selectedIds.add(item.id);
      used += item.tokenCount;
      onSelect(item.tokenCount);
      result.push(item);
    }
    return result;
  }

  /** 通过 pgvector 向量检索上下文，回退到词法搜索 */
  private async recallByPgvector(sessionId: string, text: string, limit: number): Promise<ContextRow[]> {
    const embedding = await this.createEmbedding(text);
    if (embedding) {
      try {
        const vectorLiteral = `[${embedding.join(",")}]`;
        return await this.prisma.$queryRawUnsafe<ContextRow[]>(
          `
          SELECT ci.id, ci.kind::text AS kind, ci.text, ci.token_count AS "tokenCount",
                 ci.importance, ci.pinned, ci.created_at AS "createdAt"
          FROM context_embeddings ce
          JOIN context_items ci ON ci.id = ce.context_item_id
          WHERE ce.session_id = $1::uuid
          ORDER BY ce.embedding <=> $2::vector
          LIMIT $3
        `,
          sessionId,
          vectorLiteral,
          limit,
        );
      } catch {
        // pgvector may not be migrated yet; lexical fallback
      }
    }

    const terms = text
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 1)
      .slice(0, 12);

    const rows = await this.prisma.contextItem.findMany({
      where: { sessionId },
      orderBy: [{ importance: "desc" }, { updatedAt: "desc" }],
      take: 80,
    });
    return rows
      .map((row) => ({
        ...row,
        score: terms.reduce((score, term) => score + (row.text.toLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || b.importance - a.importance)
      .slice(0, limit);
  }

  /** 生成并存储上下文条目的嵌入向量 */
  private async persistEmbedding(contextItemId: string, sessionId: string, text: string) {
    const embedding = await this.createEmbedding(text);
    if (!embedding) return;
    try {
      const vectorLiteral = `[${embedding.join(",")}]`;
      await this.prisma.$executeRawUnsafe(
        `
        INSERT INTO context_embeddings (context_item_id, session_id, model, dims, embedding)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::vector)
        ON CONFLICT (context_item_id, model) DO UPDATE
        SET embedding = EXCLUDED.embedding, dims = EXCLUDED.dims
      `,
        contextItemId,
        sessionId,
        this.embeddingModel,
        embedding.length,
        vectorLiteral,
      );
    } catch {
      // Missing pgvector extension should not block message persistence.
    }
  }

  /** 调用 OpenAI 兼容嵌入 API 生成向量 */
  private async createEmbedding(text: string): Promise<number[] | null> {
    const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_COMPATIBLE_API_KEY;
    const baseUrl = (process.env.OPENAI_COMPATIBLE_BASE_URL ?? process.env.OPENAI_BASE_URL)?.replace(/\/$/, "");
    if (!apiKey || !baseUrl || !text.trim()) return null;

    try {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.embeddingModel,
          input: text.slice(0, 12000),
        }),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const embedding = payload.data?.[0]?.embedding;
      return embedding?.length ? embedding : null;
    } catch {
      return null;
    }
  }
}

function toItem(row: ContextRow): ContextSnapshotItem {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    tokenCount: row.tokenCount,
    importance: row.importance,
    pinned: row.pinned,
    createdAt: row.createdAt.toISOString(),
  };
}

function renderContextPrompt(snapshot: ContextSnapshotPayload): string {
  const sections = [
    ["置顶上下文", snapshot.pins],
    ["最近对话", snapshot.recent],
    ["检索上下文", snapshot.retrieved],
  ] as const;

  const body = sections
    .map(([title, items]) => {
      if (items.length === 0) return `## ${title}\n(无)`;
      return `## ${title}\n${items.map((item) => `- [${item.kind}] ${item.text}`).join("\n")}`;
    })
    .join("\n\n");

  return [
    "你正在恢复一个已有的 AgentHub 会话。请先阅读以下上下文再执行操作。",
    snapshot.summary ? `## 结构化摘要\n${snapshot.summary}` : "",
    snapshot.mentionedAgents.length
      ? `## 提及的 Agent\n${snapshot.mentionedAgents.map((agent) => `- ${agent.name} (${agent.id})`).join("\n")}`
      : "",
    body,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function partText(part: Record<string, unknown>) {
  return messagePartContextText(part);
}

/** 将消息部件序列化为上下文文本 */
export function messagePartContextText(part: Record<string, unknown>) {
  const metadata = objectValue(part.metadata);
  const lines = [
    contextLine("type", part.type),
    contextLine("title", part.title),
    contextLine("url", part.url),
    contextLine("language", part.language),
    contextLine("mimeType", metadata.mimeType),
    contextLine("sizeBytes", metadata.sizeBytes),
    contextLine("description", metadata.description),
    contextLine("artifactId", metadata.artifactId),
    contextLine("kind", metadata.kind),
    contextLine("path", metadata.path),
    contextLine("changeType", metadata.changeType),
    contextLine("deploymentId", metadata.deploymentId),
    contextLine("status", metadata.status),
    contextLine("target", metadata.target),
    contextLine("commitSha", metadata.commitSha),
    contextLine("sourceArchiveUrl", metadata.sourceArchiveUrl),
    contextBlock("text", part.text),
    contextBlock("patch", metadata.patch),
    contextBlock("beforeContent", metadata.beforeContent),
    contextBlock("afterContent", metadata.afterContent),
  ].filter(Boolean);
  return lines.join("\n").slice(0, PINNED_PART_TEXT_LIMIT);
}

/** 将消息对象序列化为快照上下文文本，附带最近代码部件摘要 */
export function snapshotMessageContextText(message: {
  role?: unknown;
  agentId?: unknown;
  contentText?: unknown;
  contentJson?: unknown;
}) {
  const role = typeof message.role === "string" && message.role ? message.role : "message";
  const agentId =
    typeof message.agentId === "number" || typeof message.agentId === "string" ? `:${message.agentId}` : "";
  const contentText = typeof message.contentText === "string" ? message.contentText : "";
  const base = `${role}${agentId}: ${contentText}`;
  const codeBlocks = recentCodePartSummaries(objectValue(message.contentJson), contentText);
  return [base, ...codeBlocks].filter((item) => item.trim()).join("\n\n");
}

function recentCodePartSummaries(contentJson: Record<string, unknown>, contentText: string) {
  const parts = Array.isArray(contentJson.parts) ? contentJson.parts : [];
  return parts
    .map(objectValue)
    .filter((part) => part.type === "code")
    .filter((part) => typeof part.text === "string" && part.text.trim())
    .filter((part) => !contentText.includes((part.text as string).trim()))
    .slice(0, RECENT_CODE_PART_LIMIT)
    .map((part, index) => {
      const code = (part.text as string).trim();
      const language = typeof part.language === "string" && part.language ? `, language: ${part.language}` : "";
      const title = typeof part.title === "string" && part.title ? `, title: ${part.title}` : "";
      const preview =
        code.length > RECENT_CODE_PART_TEXT_LIMIT
          ? `${code.slice(0, RECENT_CODE_PART_TEXT_LIMIT)}\n[已截断 ${code.length - RECENT_CODE_PART_TEXT_LIMIT} 字符]`
          : code;
      return `代码片段 ${index + 1}${language}${title}, 字符数: ${code.length}:\n${preview}`;
    });
}

function contextLine(label: string, value: unknown) {
  if (typeof value === "string" && value.trim()) return `${label}: ${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `${label}: ${value}`;
  return "";
}

function contextBlock(label: string, value: unknown) {
  return typeof value === "string" && value.trim() ? `${label}:\n${value}` : "";
}

/** 将 SessionMemory 渲染为纯文本摘要（供 context snapshot 使用） */
function renderMemorySummary(memory: SessionMemoryDto): string {
  const lines: string[] = [];

  if (memory.title) lines.push(`任务：${memory.title}`);
  if (memory.status) lines.push(`状态：${memory.status}`);

  const files = memory.files as SessionMemoryFileEntry[];
  if (files.length > 0) {
    lines.push("涉及文件：");
    for (const f of files) {
      const change = f.changeType ? ` (${f.changeType})` : "";
      const desc = f.description ? ` — ${f.description}` : "";
      lines.push(`  - ${f.path}${change}${desc}`);
    }
  }

  const errors = memory.errors as SessionMemoryErrorEntry[];
  if (errors.length > 0) {
    const unsolved = errors.filter((e) => !e.resolved);
    const solved = errors.filter((e) => e.resolved);
    if (unsolved.length > 0) {
      lines.push("未解决的错误：");
      for (const e of unsolved) {
        lines.push(`  - ${e.message}${e.solution ? ` → ${e.solution}` : ""}`);
      }
    }
    if (solved.length > 0) {
      lines.push("已解决的错误：");
      for (const e of solved) {
        lines.push(`  - ${e.message}${e.solution ? ` → ${e.solution}` : ""}`);
      }
    }
  }

  if (memory.lessons) lines.push(`经验：${memory.lessons}`);

  const workLog = memory.workLog as SessionMemoryWorkLogEntry[];
  if (workLog.length > 0) {
    lines.push("最近工作：");
    for (const w of workLog.slice(0, 5)) {
      lines.push(`  - ${w.summary}`);
    }
  }

  return lines.join("\n");
}

function mergeByPath<T extends { path: string }>(
  existing: T[],
  incoming: T[],
): T[] {
  const map = new Map<string, T>();
  for (const item of existing) map.set(item.path, item);
  for (const item of incoming) map.set(item.path, item);
  return [...map.values()];
}

function mergeByMessage<T extends { message: string }>(
  existing: T[],
  incoming: T[],
): T[] {
  const map = new Map<string, T>();
  for (const item of existing) map.set(item.message, item);
  for (const item of incoming) map.set(item.message, item);
  return [...map.values()];
}
