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
  | "code_diff"
  | "preview_card"
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

export type SessionMode = "direct" | "group";

export interface SessionDto {
  id: string;
  title?: string;
  status: SessionStatus;
  /** @deprecated use agentIds */
  agentId?: string;
  agentIds?: string[];
  mode?: SessionMode;
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
  /** Single-agent shorthand; ignored when agentIds is provided. */
  config?: AgentConfigDraft;
  /** One or more agent IDs to run. Defaults to ["claude"] when omitted. */
  agentIds?: string[];
  /** "direct" (default) = single agent; "group" = fan-out to all agentIds. */
  mode?: SessionMode;
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

// --- Downstream Orchestrator (North) protocol DTOs ---

export type DownstreamConnectionState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "failed";

export interface DownstreamSessionDto {
  /** AgentHub-side session id (== conversationId) */
  agentHubSessionId: string;
  /** Downstream (orchestrator) session id, assigned by initialize/session/new */
  downstreamSessionId: string;
  /** Downstream agent identifier (e.g. "claude-code") */
  downstreamAgentId: string;
  state: DownstreamConnectionState;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DownstreamMention {
  agentId: string;
  displayName?: string;
}

export interface DownstreamPinnedContextItem {
  id: string;
  kind: "text" | "file";
  title?: string;
  body: string;
}

export interface DownstreamPromptPayload {
  text: string;
  mentions?: DownstreamMention[];
  context?: DownstreamPinnedContextItem[];
}

export interface DownstreamSessionEventDto {
  /** Globally unique downstream event id; used for ack and idempotency */
  eventId: string;
  runId: string;
  seq: number;
  ts: number;
  type: AgentEventType | string;
  payload: unknown;
}
