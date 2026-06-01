export type ISODateString = string;
export type AgentId = number;

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
export type HubMessageStatus = "queued" | "thinking" | "streaming" | "completed" | "failed" | "cancelled";
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
  id: number;
  name: string;
  description: string;
  defaultProvider: string; // "claude-code" | "open-code"
  systemPrompt: string;
  promptConfig: Record<string, unknown>;
  defaultCapabilities: unknown[];
  defaultModelConfig: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: HubAgentStatus;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface CreateAgentTemplateRequest {
  name: string;
  description: string;
  defaultProvider: string;
  systemPrompt: string;
}

export interface UpdateAgentTemplateRequest {
  name?: string;
  description?: string;
  defaultProvider?: string;
  systemPrompt?: string;
}

export interface AgentInstanceDto {
  id: AgentId;
  templateId: number;
  name: string;
  description: string;
  provider: string; // "claude-code" | "open-code"
  isDefaultOrchestrator: boolean;
  status: HubAgentStatus;
  template?: AgentTemplateDto;
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
  agentId?: AgentId | null;
  agentName?: string | null;
  parentMessageId?: string | null;
  contentText: string;
  contentJson: Record<string, unknown>;
  tokenCount: number;
  status: HubMessageStatus;
  isPinned: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface HubRunDto {
  id: string;
  sessionId: string;
  orchestratorAgentId: AgentId;
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
  speakerAgentId?: AgentId | null;
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
  mentionedAgents: Array<{ id: AgentId; name: string }>;
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

export interface LongTermSummaryDto {
  id: string;
  sessionId: string;
  seq: number;
  content: string;
  tokenCount: number;
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
  orchestratorTemplateId?: number;
  orchestratorProvider?: string; // "claude-code" | "open-code"
  orchestratorName?: string;
  memberTemplates?: Array<{ templateId: number; provider: string; name?: string }>;
}

export interface SendHubMessageRequest {
  content: string;
  mentionedAgentIds?: AgentId[];
  orchestratorAgentId?: AgentId;
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

export interface AddParticipantRequest {
  agentId: AgentId;
}

export interface CreateSessionAgentRequest {
  templateId: number;
  provider: string; // "claude-code" | "open-code"
  name: string;
  sessionId: string;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  provider?: string;
}

export interface AgentDetailResponse {
  agent: AgentInstanceDto;
  template?: AgentTemplateDto;
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
