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

export class MemoryFactSourceRepository implements FactSourceRepository, FactSourceWriter {
  private readonly events = new Map<string, AgentEvent>();
  private readonly eventSeqs = new Set<string>();
  private readonly messages = new Map<string, MessageDto>();
  private readonly fileChanges = new Map<string, FileChangeDto>();
  private readonly artifacts = new Map<string, ArtifactDto>();
  private readonly chunks = new Map<string, ArtifactChunkDto>();
  private readonly contextItems = new Map<string, ContextItemDto>();

  async transaction<T>(work: (writer: FactSourceWriter) => Promise<T>): Promise<T> {
    return work(this);
  }

  async createEventIfAbsent(event: AgentEvent): Promise<boolean> {
    const key = `${event.runId}:${event.seq}`;
    if (this.eventSeqs.has(key)) {
      return false;
    }
    this.eventSeqs.add(key);
    this.events.set(event.eventId, { ...event });
    return true;
  }

  async appendMessageDelta(input: MessageDeltaInput): Promise<MessageDto> {
    const now = new Date().toISOString();
    const existing = this.messages.get(input.id);
    const message: MessageDto = existing
      ? {
          ...existing,
          content: `${existing.content}${input.delta}`,
          metadata: input.metadata ?? existing.metadata,
          updatedAt: now
        }
      : {
          id: input.id,
          runId: input.runId,
          conversationId: input.conversationId,
          agentId: input.agentId,
          role: input.role ?? "assistant",
          status: "streaming",
          content: input.delta,
          metadata: input.metadata,
          createdAt: now,
          updatedAt: now
        };
    this.messages.set(input.id, message);
    return message;
  }

  async completeMessage(input: MessageCompleteInput): Promise<MessageDto> {
    const now = new Date().toISOString();
    const existing = this.messages.get(input.id);
    const message: MessageDto = existing
      ? {
          ...existing,
          status: "completed",
          content: input.content ?? existing.content,
          metadata: input.metadata ?? existing.metadata,
          completedAt: now,
          updatedAt: now
        }
      : {
          id: input.id,
          runId: input.runId,
          conversationId: input.conversationId,
          agentId: input.agentId,
          role: input.role ?? "assistant",
          status: "completed",
          content: input.content ?? "",
          metadata: input.metadata,
          createdAt: now,
          updatedAt: now,
          completedAt: now
        };
    this.messages.set(input.id, message);
    return message;
  }

  async upsertFileChange(input: FileChangeInput): Promise<FileChangeDto> {
    const now = new Date().toISOString();
    const existing = this.fileChanges.get(input.id);
    const change: FileChangeDto = {
      id: input.id,
      runId: input.runId,
      path: input.path,
      action: input.action ?? existing?.action ?? "modified",
      status: input.status ?? existing?.status ?? "pending",
      diff: input.diff ?? existing?.diff,
      sha256: input.sha256 ?? existing?.sha256,
      metadata: input.metadata ?? existing?.metadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.fileChanges.set(input.id, change);
    return change;
  }

  async upsertArtifact(input: ArtifactUpsertInput): Promise<ArtifactDto> {
    const now = new Date().toISOString();
    const existing = this.artifacts.get(input.id);
    const artifact: ArtifactDto = {
      id: input.id,
      runId: input.runId,
      kind: input.kind,
      path: input.path,
      status: input.status ?? existing?.status ?? "pending",
      sha256: input.sha256 ?? existing?.sha256,
      byteLength: input.byteLength ?? existing?.byteLength ?? 0,
      chunkCount: input.chunkCount ?? existing?.chunkCount ?? 0,
      storageProvider: input.storageProvider ?? existing?.storageProvider,
      storageKey: input.storageKey ?? existing?.storageKey,
      metadata: input.metadata ?? existing?.metadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      completedAt: input.completedAt ?? existing?.completedAt
    };
    this.artifacts.set(input.id, artifact);
    return artifact;
  }

  async upsertArtifactChunk(input: ArtifactChunkInput): Promise<ArtifactChunkDto> {
    const now = new Date().toISOString();
    const key = `${input.artifactId}:${input.index}`;
    const existing = this.chunks.get(key);
    const chunk: ArtifactChunkDto = {
      id: input.id,
      artifactId: input.artifactId,
      runId: input.runId,
      index: input.index,
      content: input.content,
      sha256: input.sha256 ?? existing?.sha256,
      byteLength: input.byteLength ?? Buffer.byteLength(input.content, "utf8"),
      createdAt: existing?.createdAt ?? now
    };
    this.chunks.set(key, chunk);

    const artifact = this.artifacts.get(input.artifactId);
    if (artifact) {
      const chunkCount = await this.countArtifactChunks(input.artifactId);
      this.artifacts.set(input.artifactId, {
        ...artifact,
        chunkCount,
        updatedAt: now
      });
    }

    return chunk;
  }

  async completeArtifact(input: ArtifactUpsertInput): Promise<ArtifactDto> {
    return this.upsertArtifact({
      ...input,
      status: input.status ?? "completed",
      completedAt: input.completedAt ?? new Date().toISOString()
    });
  }

  async upsertContextItem(input: ContextItemInput): Promise<ContextItemDto> {
    const now = new Date().toISOString();
    const existing = this.contextItems.get(input.id);
    const item: ContextItemDto = {
      id: input.id,
      runId: input.runId ?? existing?.runId,
      conversationId: input.conversationId,
      kind: input.kind,
      key: input.key,
      value: input.value,
      source: input.source ?? existing?.source,
      embedding: input.embedding ?? existing?.embedding,
      embeddingProvider: input.embeddingProvider ?? existing?.embeddingProvider,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.contextItems.set(input.id, item);
    return item;
  }

  async listEvents(runId: string): Promise<AgentEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.runId === runId)
      .sort((left, right) => left.seq - right.seq)
      .map((event) => ({ ...event }));
  }

  async listMessages(runId: string): Promise<MessageDto[]> {
    return [...this.messages.values()]
      .filter((message) => message.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((message) => ({ ...message }));
  }

  async listFileChanges(runId: string): Promise<FileChangeDto[]> {
    return [...this.fileChanges.values()]
      .filter((change) => change.runId === runId)
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((change) => ({ ...change }));
  }

  async listArtifacts(runId: string): Promise<ArtifactDto[]> {
    const artifacts = [...this.artifacts.values()]
      .filter((artifact) => artifact.runId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return Promise.all(
      artifacts.map(async (artifact) => ({
        ...artifact,
        chunks: await this.listArtifactChunks(artifact.id)
      }))
    );
  }

  async listArtifactChunks(artifactId: string): Promise<ArtifactChunkDto[]> {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.artifactId === artifactId)
      .sort((left, right) => left.index - right.index)
      .map((chunk) => ({ ...chunk }));
  }

  async listContextItems(input: { runId?: string; conversationId?: string }): Promise<ContextItemDto[]> {
    return [...this.contextItems.values()]
      .filter((item) => {
        if (input.runId && item.runId !== input.runId) {
          return false;
        }
        if (input.conversationId && item.conversationId !== input.conversationId) {
          return false;
        }
        return true;
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => ({ ...item }));
  }

  private async countArtifactChunks(artifactId: string): Promise<number> {
    return [...this.chunks.values()].filter((chunk) => chunk.artifactId === artifactId).length;
  }
}
