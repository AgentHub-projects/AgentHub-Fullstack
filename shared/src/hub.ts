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
  | "pptx"
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
  tools?: string[];
}

export interface UpdateAgentTemplateRequest {
  name?: string;
  description?: string;
  defaultProvider?: string;
  systemPrompt?: string;
  tools?: string[];
}

export interface AgentInstanceDto {
  id: AgentId;
  templateId: number;
  name: string;
  description: string;
  provider: string; // "claude-code" | "open-code"
  isDefaultOrchestrator: boolean;
  status: HubAgentStatus;
  capabilities: unknown[];
  template?: AgentTemplateDto;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface HubSessionDto {
  id: string;
  title: string;
  status: HubSessionStatus;
  isPinned: boolean;
  projectId?: string | null;
  metadata: Record<string, unknown>;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  lastRun?: HubRunDto | null;
}

export interface ProjectDto {
  id: string;
  name: string;
  githubUrl: string;
  defaultBranch: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export interface CreateProjectRequest {
  name: string;
  githubUrl: string;
  defaultBranch?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  githubUrl?: string;
  defaultBranch?: string;
}

export interface DeploymentDto {
  id: string;
  sessionId: string;
  projectId: string;
  triggerMessageId?: string | null;
  commitSha: string;
  status: string;
  deployServiceJobId?: string | null;
  url?: string | null;
  errorMessage?: string | null;
  metadata: Record<string, unknown>;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  completedAt?: ISODateString | null;
}

export interface StartDeploymentRequest {}

export interface StartDeploymentResponse {
  deployment: DeploymentDto;
  message: HubMessageDto;
}

export interface DeploymentPreflightResponse {
  canDeploy: boolean;
  missing: string[];
  projectBound: boolean;
  latestSuccessfulPushCommitSha: string | null;
  vercelConfigured: boolean;
  vercelProjectBound: boolean;
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
  parts: HubMessagePartDto[];
  tokenCount: number;
  status: HubMessageStatus;
  isPinned: boolean;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export type HubMessagePartType =
  | "text"
  | "code"
  | "image"
  | "file"
  | "link_preview"
  | "diff"
  | "artifact"
  | "deploy_status";

export interface HubMessagePartDto {
  id: string;
  type: HubMessagePartType | string;
  text?: string;
  language?: string;
  title?: string;
  url?: string;
  pinned?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UploadedAttachmentDto {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  url: string;
  textPreview?: string | null;
  createdAt: ISODateString;
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
  | "diff.apply.requested"
  | "diff.apply.completed"
  | "diff.apply.failed"
  | "artifact.upsert"
  | "artifact.chunk"
  | "artifact.complete"
  | "git.push.completed"
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

export interface HubArtifactVersionDto {
  id: string;
  artifactId: string;
  version: number;
  producingEventId?: string | null;
  title: string;
  kind: HubArtifactKind;
  mimeType: string;
  storageKind: HubStorageKind;
  storageUri?: string | null;
  textContent?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  final: boolean;
  metadata: Record<string, unknown>;
  createdAt: ISODateString;
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

export interface SessionDiffContextDto {
  baseRef: string;
  targetRef: string;
  projectName?: string | null;
  githubUrl?: string | null;
  defaultBranch?: string | null;
  explanation: string;
  canChangeBase: boolean;
}

export interface CreateHubSessionRequest {
  title?: string;
  metadata?: Record<string, unknown>;
  mode?: "direct" | "group";
  directTemplateId?: number;
  directProvider?: string;
  directName?: string;
  orchestratorTemplateId?: number;
  orchestratorProvider?: string; // "claude-code" | "open-code"
  orchestratorName?: string;
  memberTemplates?: Array<{ templateId: number; provider: string; name?: string }>;
}

export interface UpdateHubSessionRequest {
  title?: string;
  isPinned?: boolean;
}

export interface SendHubMessageRequest {
  content: string;
  mentionedAgentIds?: AgentId[];
  orchestratorAgentId?: AgentId;
  parentMessageId?: string;
  quotedMessageId?: string;
  references?: Array<{ messageId: string; partId?: string }>;
  attachments?: Array<{ id: string }>;
}

export interface SendHubMessageResponse {
  session: HubSessionDto;
  message: HubMessageDto;
  messages?: HubMessageDto[];
  run: HubRunDto;
  contextSnapshot?: HubContextSnapshotDto | null;
}

export interface ApplyFileChangeResponse {
  ok: boolean;
  runId: string;
  fileChangeIds: string[];
  status: "queued";
}

export interface SandboxFilesystemConnectionResponse {
  downstreamSessionId: string;
}

export interface FilesystemEntryDto {
  path: string;
  name: string;
  kind: "file" | "dir";
  size?: number | null;
  mtime?: ISODateString | null;
  version?: string | null;
}

export interface FilesystemReadFileDto {
  path: string;
  content: string;
  size: number;
  mtime: ISODateString;
  version: string;
}

export interface FilesystemTextEditDto {
  startLine: number;
  startColumn: number;
  endLine?: number;
  endColumn?: number;
  text: string;
}

export interface FilesystemUpdateFileDto {
  path: string;
  size: number;
  mtime: ISODateString;
  version: string;
  branchName?: string | null;
  commitSha?: string | null;
}

export interface FilesystemSocketErrorDto {
  code: string;
  message: string;
}

export type FilesystemSocketAck<T> =
  | { requestId?: string; ok: true; data: T }
  | { requestId?: string; ok: false; error: FilesystemSocketErrorDto };

export interface FilesystemChangedEventDto {
  path: string;
  changeType: "write" | "create" | "remove" | "rename" | string;
  mtime?: ISODateString | null;
  version?: string | null;
  actor?: string | null;
}

export interface PinHubMessageRequest {
  pinned: boolean;
  partId?: string;
}

export interface AddParticipantRequest {
  agentId: AgentId;
}

export interface CreateSessionAgentRequest {
  templateId: number;
  provider: string; // "claude-code" | "open-code"
  name?: string;
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

export interface DownstreamAgentConfigResponse {
  agentId: AgentId;
  templateId: number;
  name: string;
  description: string;
  provider: string;
  systemPrompt: string;
  promptConfig: Record<string, unknown>;
  capabilities: unknown[];
  modelConfig: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface FrontendRealtimeSubscribe {
  sessionId: string;
}

export interface FrontendRealtimeEnvelope {
  type: "event" | "session" | "message" | "artifact" | "file_change" | "context";
  sessionId: string;
  payload:
    | HubEventDto
    | HubSessionDto
    | HubMessageDto
    | HubArtifactDto
    | HubFileChangeDto
    | HubContextSnapshotDto;
}
