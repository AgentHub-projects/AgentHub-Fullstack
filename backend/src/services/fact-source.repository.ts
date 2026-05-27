import type {
  AgentEvent,
  ArtifactChunkDto,
  ArtifactDto,
  ContextItemDto,
  FileChangeDto,
  MessageDto
} from "@agenthub/shared";

export const FACT_SOURCE_REPOSITORY = Symbol("FACT_SOURCE_REPOSITORY");

export interface MessageDeltaInput {
  id: string;
  runId: string;
  conversationId: string;
  agentId: string;
  role?: string;
  delta: string;
  metadata?: unknown;
}

export interface MessageCompleteInput {
  id: string;
  runId: string;
  conversationId: string;
  agentId: string;
  role?: string;
  content?: string;
  metadata?: unknown;
}

export interface FileChangeInput {
  id: string;
  runId: string;
  path: string;
  action?: string;
  status?: string;
  diff?: string;
  sha256?: string;
  metadata?: unknown;
}

export interface ArtifactUpsertInput {
  id: string;
  runId: string;
  kind: string;
  path: string;
  status?: string;
  sha256?: string;
  byteLength?: number;
  chunkCount?: number;
  storageProvider?: string;
  storageKey?: string;
  metadata?: unknown;
  completedAt?: string;
}

export interface ArtifactChunkInput {
  id: string;
  artifactId: string;
  runId: string;
  index: number;
  content: string;
  sha256?: string;
  byteLength?: number;
}

export interface ContextItemInput {
  id: string;
  runId?: string;
  conversationId: string;
  kind: string;
  key: string;
  value: unknown;
  source?: string;
  embedding?: unknown;
  embeddingProvider?: string;
}

export interface FactSourceReader {
  listEvents(runId: string): Promise<AgentEvent[]>;
  listMessages(runId: string): Promise<MessageDto[]>;
  listFileChanges(runId: string): Promise<FileChangeDto[]>;
  listArtifacts(runId: string): Promise<ArtifactDto[]>;
  listArtifactChunks(artifactId: string): Promise<ArtifactChunkDto[]>;
  listContextItems(input: { runId?: string; conversationId?: string }): Promise<ContextItemDto[]>;
}

export interface FactSourceWriter extends FactSourceReader {
  createEventIfAbsent(event: AgentEvent): Promise<boolean>;
  appendMessageDelta(input: MessageDeltaInput): Promise<MessageDto>;
  completeMessage(input: MessageCompleteInput): Promise<MessageDto>;
  upsertFileChange(input: FileChangeInput): Promise<FileChangeDto>;
  upsertArtifact(input: ArtifactUpsertInput): Promise<ArtifactDto>;
  upsertArtifactChunk(input: ArtifactChunkInput): Promise<ArtifactChunkDto>;
  completeArtifact(input: ArtifactUpsertInput): Promise<ArtifactDto>;
  upsertContextItem(input: ContextItemInput): Promise<ContextItemDto>;
}

export interface FactSourceRepository extends FactSourceReader {
  transaction<T>(work: (writer: FactSourceWriter) => Promise<T>): Promise<T>;
}
