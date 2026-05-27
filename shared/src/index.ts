export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AgentEventType =
  | "agent_started"
  | "agent_thinking"
  | "text_delta"
  | "message_delta"
  | "message.delta"
  | "message_completed"
  | "message.completed"
  | "code_diff"
  | "file_change"
  | "file.change"
  | "preview_card"
  | "artifact_chunk"
  | "artifact.chunk"
  | "artifact_completed"
  | "artifact.completed"
  | "context_item"
  | "context.item"
  | "agent_completed"
  | "agent_failed"
  | "agent_cancelled"
  | "conflict_card"
  | "done";

export type AgentRuntimeStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type SessionStatus = "idle" | "running" | "succeeded" | "failed";

export type TestSyncStatus = "pending" | "synced" | "failed";

export type TestSyncTargetBranch = "main";

export interface ApiErrorDto {
  code: string;
  message: string;
  details?: unknown;
}

export interface AgentConfigDraft {
  name: string;
  description?: string;
  provider: string;
  role: string;
  entrypoint?: string;
  env?: Record<string, string>;
  tags?: string[];
}

export interface AgentRuntime {
  agentId: string;
  displayName: string;
  provider: string;
  role: string;
  worktreePath: string;
  branchName: string;
  status: AgentRuntimeStatus;
}

export interface AgentRun {
  id: string;
  agentId: string;
  conversationId: string;
  status: AgentRunStatus;
  runtime: AgentRuntime;
  prompt: string;
  output?: unknown;
  error?: ApiErrorDto;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AgentEvent {
  eventId: string;
  type: AgentEventType;
  runId: string;
  conversationId: string;
  agentId: string;
  messageId?: string;
  payload: unknown;
  seq: number;
  ts: number;
}

export interface MessageDto {
  id: string;
  runId: string;
  conversationId: string;
  agentId: string;
  role: string;
  status: string;
  content: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface FileChangeDto {
  id: string;
  runId: string;
  path: string;
  action: string;
  status: string;
  diff?: string;
  sha256?: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactChunkDto {
  id: string;
  artifactId: string;
  runId: string;
  index: number;
  content: string;
  sha256?: string;
  byteLength: number;
  createdAt: string;
}

export interface ArtifactDto {
  id: string;
  runId: string;
  kind: string;
  path: string;
  status: string;
  sha256?: string;
  byteLength: number;
  chunkCount: number;
  storageProvider?: string;
  storageKey?: string;
  metadata?: unknown;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  chunks?: ArtifactChunkDto[];
}

export interface ContextItemDto {
  id: string;
  runId?: string;
  conversationId: string;
  kind: string;
  key: string;
  value: unknown;
  source?: string;
  embedding?: unknown;
  embeddingProvider?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunStateDto {
  runId: string;
  timeline: AgentEvent[];
  messages: MessageDto[];
  fileChanges: FileChangeDto[];
  artifacts: ArtifactDto[];
  contextItems: ContextItemDto[];
}

export interface SessionDto {
  id: string;
  title?: string;
  status: SessionStatus;
  agentId?: string;
  runIds: string[];
  prompt?: string;
  output?: string;
  error?: string;
  testSync?: TestSyncResultDto;
  createdAt: string;
  updatedAt: string;
}

export interface RunSessionRequest {
  prompt: string;
  repositoryPath?: string;
  testRepositoryPath?: string;
  config?: AgentConfigDraft;
}

export interface RunSessionResponse {
  session: SessionDto;
  run: AgentRun;
}

export interface CancelRunResponse {
  session: SessionDto;
  run: AgentRun;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  ts: string;
}

export interface TestSyncResultDto {
  status: TestSyncStatus;
  targetBranch: TestSyncTargetBranch;
  commitSha?: string;
  summaryPath?: string;
  error?: ApiErrorDto;
}
