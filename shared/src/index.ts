export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export const DEFAULT_WORKSPACE_PATH = "D:\\agent\\AgentHub-Test";

export type AgentEventType =
  | "agent_started"
  | "agent_thinking"
  | "text_delta"
  | "tool_use"
  | "tool_result"
  | "code_diff"
  | "preview_card"
  | "agent_completed"
  | "agent_failed"
  | "agent_cancelled"
  | "conflict_card"
  | "done"
  // Team orchestration events
  | "team_planning"
  | "team_plan_ready"
  | "worker_assigned"
  | "worker_result"
  | "team_verifying"
  | "team_verdict_ready"
  | "team_completed"
  | "team_failed"
  // Frontend-safe public events
  | "public_text"
  | "plan_card"
  | "assignment_card"
  | "result_card";

export type AgentRuntimeStatus =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type SessionStatus = "idle" | "running" | "succeeded" | "failed";

export type TestSyncStatus = "pending" | "synced" | "failed";

export type TestSyncTargetBranch = "main";

export type TeamRunStatus =
  | "planning"
  | "executing"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TeamMemberRole = "leader" | "worker";

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
  systemPrompt?: string;
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
  teamRunId?: string;
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
  teamRunId?: string;
  payload: unknown;
  seq: number;
  ts: number;
}

export interface PublicTextPayload {
  text: string;
  title?: string;
  variant?: "info" | "success" | "warning" | "error";
}

export interface PlanCardPayload {
  plan: TeamPlan;
}

export interface AssignmentCardPayload {
  agentId: string;
  task: string;
  dependsOn: string[];
}

export interface ResultCardPayload {
  agentId: string;
  title: string;
  summary: string;
  status: "succeeded" | "failed";
}

export interface CodeDiffPreview {
  worktreePath: string;
  branchName: string;
  changedFiles: string[];
  stat: string;
  patch: string;
  truncated: boolean;
}

export interface SessionDto {
  id: string;
  title?: string;
  status: SessionStatus;
  agentId?: string;
  runIds: string[];
  activeRunIds: string[];
  prompt?: string;
  output?: string;
  error?: string;
  testSync?: TestSyncResultDto;
  createdAt: string;
  updatedAt: string;
}

export interface RunSessionRequest {
  prompt: string;
  conversationId?: string;
  repositoryPath?: string;
  testRepositoryPath?: string;
  config?: AgentConfigDraft;
  mode?: "single" | "team";
  teamId?: string;
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

// ---- Conversation & Message types ----

export type ConversationType = "direct" | "team";

export interface ConversationDto {
  id: string;
  title: string;
  agentId: string;
  type: ConversationType;
  teamId?: string;
  workspacePath: string;
  status: SessionStatus;
  isPinned: boolean;
  isArchived: boolean;
  messageCount: number;
  pinnedMessageIds: string[];
  pinnedAt?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  agentId?: string;
  quotedMessageId?: string;
  pinned?: boolean;
  createdAt: string;
}

export interface CreateConversationRequest {
  title?: string;
  agentId?: string;
  type?: ConversationType;
  teamId?: string;
  workspacePath?: string;
}

export interface CreateMessageRequest {
  content: string;
  agentId?: string;
  quotedMessageId?: string;
}

export interface UpdateConversationRequest {
  title?: string;
  isPinned?: boolean;
  isArchived?: boolean;
  workspacePath?: string;
}

export interface PinMessageRequest {
  pinned: boolean;
}

// ---- Agent types ----

export interface AgentDto {
  id: string;
  name: string;
  description: string;
  provider: string;
  role: string;
  avatar?: string;
  tags: string[];
  systemPrompt?: string;
  createdAt: string;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  provider?: string;
  role?: string;
  tags?: string[];
  systemPrompt?: string;
}

// ---- Team types ----

export interface TeamMemberConfig {
  agentId: string;
  role: TeamMemberRole;
}

export interface TeamDto {
  id: string;
  name: string;
  description: string;
  members: TeamMemberConfig[];
  createdAt: string;
}

export interface CreateTeamRequest {
  name: string;
  description?: string;
  members: TeamMemberConfig[];
}

// ---- Team Run types ----

export interface TeamTask {
  agentId: string;
  task: string;
  dependsOn: string[];
}

export interface TeamPlan {
  summary: string;
  tasks: TeamTask[];
}

export interface TeamVerdict {
  verdict: "complete" | "rework";
  summary: string;
  rework?: Record<string, string>;
}

export interface TeamTaskResult {
  agentId: string;
  runId: string;
  status: "succeeded" | "failed";
  output: string;
  diffPreview?: CodeDiffPreview;
  sync?: TestSyncResultDto;
}

export interface TeamRunDto {
  id: string;
  teamId: string;
  conversationId: string;
  status: TeamRunStatus;
  plan?: TeamPlan;
  taskResults: TeamTaskResult[];
  verdict?: TeamVerdict;
  leaderRunIds: string[];
  workerRunIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StartTeamRunRequest {
  prompt: string;
  conversationId?: string;
  repositoryPath?: string;
}

// ---- Agent Channel types (per-agent WebSocket channels) ----

export interface AgentSubscribeRequest {
  agentId: string;
  runId: string;
  conversationId: string;
}

export type AgentChannelEventType =
  | "agent:start"
  | "agent:stream"
  | "agent:error"
  | "agent:complete";

export interface AgentChannelEvent extends AgentEvent {
  channelType: AgentChannelEventType;
}

// ---- AgentScope-inspired Tool Definition (agent-as-tool) ----

export interface ToolParameterSchema {
  type: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

// ---- ACP Protocol types ----

export type AcpTransport = "socketio" | "acp";

export interface AcpMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolCallId?: string;
  agentId?: string;
  runId?: string;
  conversationId?: string;
}
