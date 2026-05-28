import { Inject, Injectable } from "@nestjs/common";
import type {
  AgentInstanceDto,
  ContextSnapshotItem,
  ContextSnapshotPayload,
  HubContextSnapshotDto,
  HubContextItemKind,
  LongTermSummaryDto,
} from "@agenthub/shared";
import { PrismaService } from "./prisma.service";
import { mapContextSnapshot, mapLongTermSummary } from "./hub.mappers";

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

  estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }

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
    const longTermSummaries = await this.loadSummaryChain(input.sessionId);

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
        .map((message) => ({
          id: message.id,
          kind: "message" as const,
          text: `${message.role}${message.agentId ? `:${message.agentId}` : ""}: ${message.contentText}`,
          tokenCount: message.tokenCount || this.estimateTokens(message.contentText),
          importance: message.isPinned ? 100 : 0,
          pinned: message.isPinned,
          createdAt: message.createdAt.toISOString(),
        })),
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

    const summaryText = longTermSummaries.map((s) => s.content).join("\n");

    const payload: ContextSnapshotPayload = {
      pins,
      recent,
      retrieved,
      summary: summaryText || "",
      mentionedAgents: input.mentionedAgents.map((agent) => ({ id: agent.id, name: agent.name })),
    };

    const promptText = renderContextPrompt(payload);
    const snapshot = await this.prisma.contextSnapshot.create({
      data: {
        sessionId: input.sessionId,
        runId: input.runId,
        tokenBudget: this.tokenBudget,
        tokenCount: total + this.estimateTokens(summaryText),
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

  // ---- Incremental Summary Chain ----

  async loadSummaryChain(sessionId: string): Promise<LongTermSummaryDto[]> {
    const rows = await this.prisma.longTermSummary.findMany({
      where: { sessionId },
      orderBy: { seq: "asc" },
    });
    return rows.map(mapLongTermSummary);
  }

  private async appendShortTermBuffer(sessionId: string, text: string) {
    let buffer = shortTermBuffers.get(sessionId);
    if (!buffer) {
      buffer = { events: [], tokenCount: 0 };
      shortTermBuffers.set(sessionId, buffer);
    }

    buffer.events.push(text);
    buffer.tokenCount += this.estimateTokens(text);

    if (buffer.events.length >= SHORT_TERM_EVENT_LIMIT || buffer.tokenCount >= SHORT_TERM_TOKEN_LIMIT) {
      await this.compressShortTerm(sessionId, buffer);
    }
  }

  private async compressShortTerm(
    sessionId: string,
    buffer: { events: string[]; tokenCount: number },
  ) {
    const text = buffer.events.join("\n");
    const summary = await this.invokeSummaryLLM(text);

    const lastSeq = await this.getNextSeq(sessionId);
    await this.prisma.longTermSummary.create({
      data: {
        sessionId,
        seq: lastSeq,
        content: summary,
        tokenCount: this.estimateTokens(summary),
      },
    });

    // Reset short-term buffer
    buffer.events = [];
    buffer.tokenCount = 0;
  }

  private async invokeSummaryLLM(text: string): Promise<string> {
    if (!this.summaryApiKey || !this.summaryBaseUrl) {
      // Fallback: simple truncation
      return text.slice(0, 4000);
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
              content: "请用中文将以下 Agent 群聊记录压缩为简洁摘要（200字以内），保留关键任务、决策、产出和未解决问题。",
            },
            { role: "user", content: text.slice(0, 8000) },
          ],
          max_tokens: 400,
          temperature: 0.3,
        }),
      });

      if (!response.ok) return text.slice(0, 4000);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return payload.choices?.[0]?.message?.content ?? text.slice(0, 4000);
    } catch {
      return text.slice(0, 4000);
    }
  }

  private async getNextSeq(sessionId: string): Promise<number> {
    const result = await this.prisma.longTermSummary.aggregate({
      where: { sessionId },
      _max: { seq: true },
    });
    return (result._max.seq ?? 0) + 1;
  }

  // ---- Embedding & Vector Recall ----

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
    ["Pinned Context", snapshot.pins],
    ["Recent Turns", snapshot.recent],
    ["Retrieved Context", snapshot.retrieved],
  ] as const;

  const body = sections
    .map(([title, items]) => {
      if (items.length === 0) return `## ${title}\n(empty)`;
      return `## ${title}\n${items.map((item) => `- [${item.kind}] ${item.text}`).join("\n")}`;
    })
    .join("\n\n");

  return [
    "You are resuming an existing AgentHub session. Use the context below before acting.",
    snapshot.summary ? `## Structured Summary\n${snapshot.summary}` : "",
    snapshot.mentionedAgents.length
      ? `## Mentioned Agents\n${snapshot.mentionedAgents.map((agent) => `- ${agent.name} (${agent.id})`).join("\n")}`
      : "",
    body,
  ]
    .filter(Boolean)
    .join("\n\n");
}
