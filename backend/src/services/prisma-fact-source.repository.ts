import { Inject, Injectable } from "@nestjs/common";
import type {
  AgentEvent,
  ArtifactChunkDto,
  ArtifactDto,
  ContextItemDto,
  FileChangeDto,
  MessageDto
} from "@agenthub/shared";
import type {
  ArtifactChunkInput,
  ArtifactUpsertInput,
  ContextItemInput,
  FactSourceRepository,
  FactSourceWriter,
  FileChangeInput,
  MessageCompleteInput,
  MessageDeltaInput
} from "./fact-source.repository";
import { PrismaService } from "./prisma.service";

type PrismaLike = Record<string, any>;

@Injectable()
export class PrismaFactSourceRepository implements FactSourceRepository, FactSourceWriter {
  private readonly db: PrismaLike;

  constructor(@Inject(PrismaService) db: PrismaService | PrismaLike) {
    this.db = db as PrismaLike;
  }

  async transaction<T>(work: (writer: FactSourceWriter) => Promise<T>): Promise<T> {
    return this.db.$transaction(async (tx: PrismaLike) => work(new PrismaFactSourceRepository(tx))) as Promise<T>;
  }

  async createEventIfAbsent(event: AgentEvent): Promise<boolean> {
    try {
      await this.db.agentEvent.create({
        data: {
          eventId: event.eventId,
          runId: event.runId,
          conversationId: event.conversationId,
          agentId: event.agentId,
          type: event.type,
          seq: event.seq,
          payload: event.payload,
          ts: BigInt(event.ts)
        }
      });
      return true;
    } catch (error) {
      if (isUniqueConflict(error)) {
        return false;
      }
      throw error;
    }
  }

  async appendMessageDelta(input: MessageDeltaInput): Promise<MessageDto> {
    const existing = await this.db.message.findUnique({ where: { id: input.id } });
    const now = new Date();
    const row = existing
      ? await this.db.message.update({
          where: { id: input.id },
          data: {
            content: `${existing.content}${input.delta}`,
            metadata: input.metadata ?? existing.metadata,
            updatedAt: now
          }
        })
      : await this.db.message.create({
          data: {
            id: input.id,
            runId: input.runId,
            conversationId: input.conversationId,
            agentId: input.agentId,
            role: input.role ?? "assistant",
            status: "streaming",
            content: input.delta,
            metadata: input.metadata
          }
        });
    return toMessageDto(row);
  }

  async completeMessage(input: MessageCompleteInput): Promise<MessageDto> {
    const existing = await this.db.message.findUnique({ where: { id: input.id } });
    const now = new Date();
    const row = existing
      ? await this.db.message.update({
          where: { id: input.id },
          data: {
            status: "completed",
            content: input.content ?? existing.content,
            metadata: input.metadata ?? existing.metadata,
            completedAt: now,
            updatedAt: now
          }
        })
      : await this.db.message.create({
          data: {
            id: input.id,
            runId: input.runId,
            conversationId: input.conversationId,
            agentId: input.agentId,
            role: input.role ?? "assistant",
            status: "completed",
            content: input.content ?? "",
            metadata: input.metadata,
            completedAt: now
          }
        });
    return toMessageDto(row);
  }

  async upsertFileChange(input: FileChangeInput): Promise<FileChangeDto> {
    const row = await this.db.fileChange.upsert({
      where: { id: input.id },
      update: {
        path: input.path,
        action: input.action ?? "modified",
        status: input.status ?? "pending",
        diff: input.diff,
        sha256: input.sha256,
        metadata: input.metadata
      },
      create: {
        id: input.id,
        runId: input.runId,
        path: input.path,
        action: input.action ?? "modified",
        status: input.status ?? "pending",
        diff: input.diff,
        sha256: input.sha256,
        metadata: input.metadata
      }
    });
    return toFileChangeDto(row);
  }

  async upsertArtifact(input: ArtifactUpsertInput): Promise<ArtifactDto> {
    const row = await this.db.artifact.upsert({
      where: { id: input.id },
      update: artifactUpdateData(input),
      create: {
        id: input.id,
        runId: input.runId,
        kind: input.kind,
        path: input.path,
        status: input.status ?? "pending",
        sha256: input.sha256,
        byteLength: input.byteLength ?? 0,
        chunkCount: input.chunkCount ?? 0,
        storageProvider: input.storageProvider,
        storageKey: input.storageKey,
        metadata: input.metadata,
        completedAt: input.completedAt ? new Date(input.completedAt) : undefined
      }
    });
    return toArtifactDto(row);
  }

  async upsertArtifactChunk(input: ArtifactChunkInput): Promise<ArtifactChunkDto> {
    const row = await this.db.artifactChunk.upsert({
      where: { artifactId_index: { artifactId: input.artifactId, index: input.index } },
      update: {
        content: input.content,
        sha256: input.sha256,
        byteLength: input.byteLength ?? Buffer.byteLength(input.content, "utf8")
      },
      create: {
        id: input.id,
        artifactId: input.artifactId,
        runId: input.runId,
        index: input.index,
        content: input.content,
        sha256: input.sha256,
        byteLength: input.byteLength ?? Buffer.byteLength(input.content, "utf8")
      }
    });
    const chunkCount = await this.db.artifactChunk.count({ where: { artifactId: input.artifactId } });
    await this.db.artifact.update({
      where: { id: input.artifactId },
      data: { chunkCount }
    });
    return toArtifactChunkDto(row);
  }

  async completeArtifact(input: ArtifactUpsertInput): Promise<ArtifactDto> {
    return this.upsertArtifact({
      ...input,
      status: input.status ?? "completed",
      completedAt: input.completedAt ?? new Date().toISOString()
    });
  }

  async upsertContextItem(input: ContextItemInput): Promise<ContextItemDto> {
    const row = await this.db.contextItem.upsert({
      where: { id: input.id },
      update: {
        runId: input.runId,
        conversationId: input.conversationId,
        kind: input.kind,
        key: input.key,
        value: input.value,
        source: input.source,
        embedding: input.embedding,
        embeddingProvider: input.embeddingProvider
      },
      create: {
        id: input.id,
        runId: input.runId,
        conversationId: input.conversationId,
        kind: input.kind,
        key: input.key,
        value: input.value,
        source: input.source,
        embedding: input.embedding,
        embeddingProvider: input.embeddingProvider
      }
    });
    return toContextItemDto(row);
  }

  async listEvents(runId: string): Promise<AgentEvent[]> {
    const rows = await this.db.agentEvent.findMany({
      where: { runId },
      orderBy: { seq: "asc" }
    });
    return rows.map(toAgentEvent);
  }

  async listMessages(runId: string): Promise<MessageDto[]> {
    const rows = await this.db.message.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" }
    });
    return rows.map(toMessageDto);
  }

  async listFileChanges(runId: string): Promise<FileChangeDto[]> {
    const rows = await this.db.fileChange.findMany({
      where: { runId },
      orderBy: { path: "asc" }
    });
    return rows.map(toFileChangeDto);
  }

  async listArtifacts(runId: string): Promise<ArtifactDto[]> {
    const rows = await this.db.artifact.findMany({
      where: { runId },
      include: { chunks: { orderBy: { index: "asc" } } },
      orderBy: { createdAt: "asc" }
    });
    return rows.map((row: any) => ({
      ...toArtifactDto(row),
      chunks: row.chunks.map(toArtifactChunkDto)
    }));
  }

  async listArtifactChunks(artifactId: string): Promise<ArtifactChunkDto[]> {
    const rows = await this.db.artifactChunk.findMany({
      where: { artifactId },
      orderBy: { index: "asc" }
    });
    return rows.map(toArtifactChunkDto);
  }

  async listContextItems(input: { runId?: string; conversationId?: string }): Promise<ContextItemDto[]> {
    const rows = await this.db.contextItem.findMany({
      where: {
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {})
      },
      orderBy: { createdAt: "asc" }
    });
    return rows.map(toContextItemDto);
  }
}

function artifactUpdateData(input: ArtifactUpsertInput): Record<string, unknown> {
  return definedObject({
    kind: input.kind,
    path: input.path,
    status: input.status,
    sha256: input.sha256,
    byteLength: input.byteLength,
    chunkCount: input.chunkCount,
    storageProvider: input.storageProvider,
    storageKey: input.storageKey,
    metadata: input.metadata,
    completedAt: input.completedAt ? new Date(input.completedAt) : undefined
  });
}

function definedObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function toAgentEvent(row: any): AgentEvent {
  return {
    eventId: row.eventId,
    runId: row.runId,
    conversationId: row.conversationId,
    agentId: row.agentId,
    type: row.type,
    seq: row.seq,
    payload: row.payload,
    ts: Number(row.ts)
  };
}

function toMessageDto(row: any): MessageDto {
  return {
    id: row.id,
    runId: row.runId,
    conversationId: row.conversationId,
    agentId: row.agentId,
    role: row.role,
    status: row.status,
    content: row.content,
    metadata: row.metadata ?? undefined,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    completedAt: row.completedAt ? toIso(row.completedAt) : undefined
  };
}

function toFileChangeDto(row: any): FileChangeDto {
  return {
    id: row.id,
    runId: row.runId,
    path: row.path,
    action: row.action,
    status: row.status,
    diff: row.diff ?? undefined,
    sha256: row.sha256 ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function toArtifactDto(row: any): ArtifactDto {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    path: row.path,
    status: row.status,
    sha256: row.sha256 ?? undefined,
    byteLength: row.byteLength,
    chunkCount: row.chunkCount,
    storageProvider: row.storageProvider ?? undefined,
    storageKey: row.storageKey ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: toIso(row.createdAt),
    updatedAt: row.updatedAt ? toIso(row.updatedAt) : undefined,
    completedAt: row.completedAt ? toIso(row.completedAt) : undefined
  };
}

function toArtifactChunkDto(row: any): ArtifactChunkDto {
  return {
    id: row.id,
    artifactId: row.artifactId,
    runId: row.runId,
    index: row.index,
    content: row.content,
    sha256: row.sha256 ?? undefined,
    byteLength: row.byteLength,
    createdAt: toIso(row.createdAt)
  };
}

function toContextItemDto(row: any): ContextItemDto {
  return {
    id: row.id,
    runId: row.runId ?? undefined,
    conversationId: row.conversationId,
    kind: row.kind,
    key: row.key,
    value: row.value,
    source: row.source ?? undefined,
    embedding: row.embedding ?? undefined,
    embeddingProvider: row.embeddingProvider ?? undefined,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt)
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";
}
