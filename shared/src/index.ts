export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentEventType =
  | "run.created"
  | "run.started"
  | "run.output"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

export type AgentRuntime = "node" | "browser" | "python" | "shell";

export type SessionStatus = "idle" | "running" | "completed" | "failed";

export type TestSyncStatus = "pending" | "synced" | "failed";

export interface ApiErrorDto {
  code: string;
  message: string;
  details?: unknown;
}

export interface AgentConfigDraft {
  name: string;
  description?: string;
  runtime: AgentRuntime;
  entrypoint: string;
  env?: Record<string, string>;
  tags?: string[];
}

export interface AgentRun {
  id: string;
  agentId: string;
  sessionId?: string;
  status: AgentRunStatus;
  runtime: AgentRuntime;
  input?: unknown;
  output?: unknown;
  error?: ApiErrorDto;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AgentEvent {
  id: string;
  runId: string;
  type: AgentEventType;
  timestamp: string;
  message?: string;
  data?: unknown;
}

export interface SessionDto {
  id: string;
  title?: string;
  status: SessionStatus;
  agentId?: string;
  runIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RunSessionRequest {
  agentId: string;
  sessionId?: string;
  input?: unknown;
  config?: AgentConfigDraft;
}

export interface TestSyncResultDto {
  status: TestSyncStatus;
  syncedAt?: string;
  message?: string;
  error?: ApiErrorDto;
}
