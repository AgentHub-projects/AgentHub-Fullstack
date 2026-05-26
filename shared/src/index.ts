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

// ---- AgentHub v1 shared contract ----

export type ISODateString = string;

export type HubSessionStatus = "active" | "archived" | "deleted";
export type HubMessageRole = "user" | "assistant" | "agent" | "system" | "tool";
export type HubRunStatus =
  | "queued"
  | "context_building"
  | "connecting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type HubAgentStatus = "enabled" | "disabled" | "offline" | "error";
export type HubConnectionStatus = "connecting" | "connected" | "closed" | "failed";
export type HubArtifactKind =
  | "markdown"
  | "text"
  | "html"
  | "pdf"
  | "docx"
  | "image"
  | "archive"
  | "log"
  | "other";
export type HubStorageKind = "inline_text" | "oss_object" | "remote_url";
export type HubFileChangeType = "added" | "modified" | "deleted" | "renamed";
export type HubContextItemKind =
  | "message"
  | "artifact"
  | "file_change"
  | "run_summary"
  | "manual_pin";

export interface AgentTemplateDto {
  id: string;
  name: string;
  description: string;
  agentKind: "orchestrator" | "worker" | "reviewer" | "utility" | string;
  systemPrompt: string;
  promptConfig: Record<string, unknown>;
  defaultCapabilities: unknown[];
  defaultModelConfig: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: HubAgentStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface AgentInstanceDto {
  id: string;
  templateId: string;
  name: string;
  description: string;
  endpointUrl?: string | null;
  protocolProfile: "north-socketio-jsonrpc" | "agenthub-wss-json" | string;
  isDefaultOrchestrator: boolean;
  authType: "none" | "bearer" | "header" | string;
  authSecretRef?: string | null;
  capabilitiesOverride: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  sandbox: Record<string, unknown>;
  status: HubAgentStatus;
  template?: AgentTemplateDto;
  lastSeenAt?: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface HubSessionDto {
  id: string;
  title: string;
  status: HubSessionStatus;
  metadata: Record<string, unknown>;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  lastRun?: HubRunDto | null;
}

export interface HubMessageDto {
  id: string;
  sessionId: string;
  runId?: string | null;
  role: HubMessageRole;
  agentId?: string | null;
  agentName?: string | null;
  parentMessageId?: string | null;
  contentText: string;
  contentJson: Record<string, unknown>;
  tokenCount: number;
  isPinned: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface HubRunDto {
  id: string;
  sessionId: string;
  orchestratorAgentId: string;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  contextSnapshotId?: string | null;
  status: HubRunStatus;
  downstreamSessionId?: string | null;
  downstreamRunId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  usageJson: Record<string, unknown>;
  startedAt?: ISODateString | null;
  completedAt?: ISODateString | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  mentions?: HubMentionDto[];
}

export interface HubMentionDto {
  id: string;
  sessionId: string;
  runId: string;
  agentId?: string | null;
  mentionLabel: string;
  source: string;
  createdAt: ISODateString;
}

export type HubEventType =
  | "run.created"
  | "run.status"
  | "message.delta"
  | "message.completed"
  | "tool.call"
  | "tool.result"
  | "file.change"
  | "artifact.upsert"
  | "artifact.chunk"
  | "artifact.complete"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "context.updated";

export interface HubEventDto {
  id: string;
  sessionId: string;
  runId: string;
  seq: number;
  source: string;
  eventType: HubEventType | string;
  visibility: "public" | "private" | string;
  speakerAgentId?: string | null;
  speakerName?: string | null;
  payload: Record<string, unknown>;
  occurredAt?: ISODateString | null;
  persistedAt: ISODateString;
}

export interface HubArtifactDto {
  id: string;
  sessionId: string;
  runId?: string | null;
  producingEventId?: string | null;
  artifactKey?: string | null;
  kind: HubArtifactKind;
  title: string;
  mimeType: string;
  storageKind: HubStorageKind;
  storageUri?: string | null;
  textContent?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  version: number;
  final: boolean;
  metadata: Record<string, unknown>;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface HubFileChangeDto {
  id: string;
  sessionId: string;
  runId: string;
  artifactId?: string | null;
  producingEventId?: string | null;
  path: string;
  oldPath?: string | null;
  changeType: HubFileChangeType;
  language?: string | null;
  beforeContent?: string | null;
  beforeSha256?: string | null;
  beforeTruncated: boolean;
  afterContent?: string | null;
  afterSha256?: string | null;
  afterTruncated: boolean;
  patch?: string | null;
  stats: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: ISODateString;
}

export interface HubContextSnapshotDto {
  id: string;
  sessionId: string;
  runId?: string | null;
  version: number;
  tokenBudget: number;
  tokenCount: number;
  selectedItemIds: string[];
  snapshotJson: ContextSnapshotPayload;
  promptText: string;
  createdAt: ISODateString;
}

export interface ContextSnapshotPayload {
  pins: ContextSnapshotItem[];
  recent: ContextSnapshotItem[];
  retrieved: ContextSnapshotItem[];
  summary?: string;
  mentionedAgents: Array<{ id: string; name: string }>;
}

export interface ContextSnapshotItem {
  id: string;
  kind: HubContextItemKind | string;
  text: string;
  tokenCount: number;
  importance: number;
  pinned: boolean;
  createdAt: ISODateString;
}

export interface SessionDetailDto {
  session: HubSessionDto;
  messages: HubMessageDto[];
  runs: HubRunDto[];
  events: HubEventDto[];
  artifacts: HubArtifactDto[];
  fileChanges: HubFileChangeDto[];
  context?: HubContextSnapshotDto | null;
}

export interface CreateHubSessionRequest {
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface SendHubMessageRequest {
  content: string;
  mentionedAgentIds?: string[];
  orchestratorAgentId?: string;
  parentMessageId?: string;
}

export interface SendHubMessageResponse {
  session: HubSessionDto;
  message: HubMessageDto;
  run: HubRunDto;
  contextSnapshot: HubContextSnapshotDto;
}

export interface PinHubMessageRequest {
  pinned: boolean;
}

export interface DownstreamInitializeParams {
  protocolVersion: string;
  clientInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

export interface DownstreamPromptInput {
  agenthubSessionId: string;
  runId: string;
  messageId: string;
  agentId: string;
  mentionedAgentIds: string[];
  mentionedAgentNames: string[];
  prompt: Array<{ type: "text"; text: string }>;
  context: HubContextSnapshotDto;
  metadata?: Record<string, unknown>;
}

export interface FrontendRealtimeSubscribe {
  sessionId: string;
}

export interface FrontendRealtimeEnvelope {
  type: "event" | "session" | "artifact" | "file_change" | "context";
  sessionId: string;
  payload:
    | HubEventDto
    | HubSessionDto
    | HubArtifactDto
    | HubFileChangeDto
    | HubContextSnapshotDto;
}
