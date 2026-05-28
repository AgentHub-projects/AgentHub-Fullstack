import { Inject, Injectable } from "@nestjs/common";
import type { ContextItemDto } from "@agenthub/shared";
import {
  FACT_SOURCE_REPOSITORY,
  type ContextItemInput,
  type FactSourceRepository
} from "./fact-source.repository";

export interface ContextSearchResult {
  provider: "pgvector" | "local";
  fallbackReason?: string;
  items: ContextItemDto[];
}

@Injectable()
export class ContextService {
  constructor(@Inject(FACT_SOURCE_REPOSITORY) private readonly repository: FactSourceRepository) {}

  async upsert(input: ContextItemInput): Promise<ContextItemDto> {
    return this.repository.transaction((writer) => writer.upsertContextItem(input));
  }

  async search(input: { conversationId: string; runId?: string; query?: string; limit?: number }): Promise<ContextSearchResult> {
    const configured = isPgvectorConfigured();
    const items = await this.repository.listContextItems({
      runId: input.runId,
      conversationId: input.conversationId
    });
    const ranked = rankLocally(items, input.query ?? "").slice(0, input.limit ?? 20);
    if (configured) {
      return {
        provider: "pgvector",
        fallbackReason: "pgvector adapter is not bundled in this backend yet; returning deterministic local ranking.",
        items: ranked
      };
    }
    return {
      provider: "local",
      fallbackReason: "pgvector is not configured; returning deterministic local ranking.",
      items: ranked
    };
  }
}

function isPgvectorConfigured(): boolean {
  return process.env.AGENTHUB_PGVECTOR_ENABLED === "true" && Boolean(process.env.DATABASE_URL);
}

function rankLocally(items: ContextItemDto[], query: string): ContextItemDto[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  return [...items]
    .map((item) => ({
      item,
      score: JSON.stringify(item.value).toLowerCase().includes(normalizedQuery) || item.key.toLowerCase().includes(normalizedQuery) ? 1 : 0
    }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return right.item.createdAt.localeCompare(left.item.createdAt);
    })
    .map((entry) => entry.item);
}
