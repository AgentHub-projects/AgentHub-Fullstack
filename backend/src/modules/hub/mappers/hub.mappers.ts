import type {
  AgentInstanceDto,
  AgentTemplateDto,
  HubArtifactDto,
  HubContextSnapshotDto,
  HubEventDto,
  HubFileChangeDto,
  HubMessageDto,
  HubRunDto,
  HubSessionDto,
  LongTermSummaryDto,
} from "@agenthub/shared";

type Row = Record<string, any>;

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function iso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function maybeIso(value: Date | string | null | undefined): string | null {
  return value ? iso(value) : null;
}

export function mapTemplate(row: Row): AgentTemplateDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    defaultProvider: row.defaultProvider ?? 0,
    systemPrompt: row.systemPrompt ?? "",
    promptConfig: asObject(row.promptConfig),
    defaultCapabilities: asArray(row.defaultCapabilities),
    defaultModelConfig: asObject(row.defaultModelConfig),
    metadata: asObject(row.metadata),
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function mapAgent(row: Row): AgentInstanceDto {
  return {
    id: row.id,
    templateId: row.templateId,
    name: row.name,
    description: row.description ?? "",
    provider: row.provider ?? 0,
    isDefaultOrchestrator: Boolean(row.isDefaultOrchestrator),
    status: row.status,
    template: row.template ? mapTemplate(row.template) : undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function mapSession(row: Row): HubSessionDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    metadata: asObject(row.metadata),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    lastRun: row.runs?.[0] ? mapRun(row.runs[0]) : undefined,
  };
}

export function mapMessage(row: Row): HubMessageDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId ?? null,
    role: row.role,
    agentId: row.agentId ?? null,
    agentName: row.agent?.name ?? null,
    parentMessageId: row.parentMessageId ?? null,
    contentText: row.contentText ?? "",
    contentJson: asObject(row.contentJson),
    tokenCount: row.tokenCount ?? 0,
    status: row.status ?? "completed",
    isPinned: Boolean(row.isPinned),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function mapRun(row: Row): HubRunDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    orchestratorAgentId: row.orchestratorAgentId,
    userMessageId: row.userMessageId ?? null,
    assistantMessageId: row.assistantMessageId ?? null,
    contextSnapshotId: row.contextSnapshotId ?? null,
    status: row.status,
    downstreamSessionId: row.downstreamSessionId ?? null,
    downstreamRunId: row.downstreamRunId ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    usageJson: asObject(row.usageJson),
    startedAt: maybeIso(row.startedAt),
    completedAt: maybeIso(row.completedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function mapEvent(row: Row): HubEventDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId,
    seq: Number(row.seq),
    source: row.source,
    eventType: row.eventType,
    visibility: row.visibility,
    speakerAgentId: row.speakerAgentId ?? null,
    speakerName: row.speakerName ?? null,
    payload: asObject(row.payload),
    occurredAt: maybeIso(row.occurredAt),
    persistedAt: iso(row.persistedAt),
  };
}

export function mapArtifact(row: Row): HubArtifactDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId ?? null,
    producingEventId: row.producingEventId ?? null,
    artifactKey: row.artifactKey ?? null,
    kind: row.kind,
    title: row.title,
    mimeType: row.mimeType,
    storageKind: row.storageKind,
    storageUri: row.storageUri ?? null,
    textContent: row.textContent ?? null,
    sha256: row.sha256 ?? null,
    sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
    version: row.version,
    final: Boolean(row.final),
    metadata: asObject(row.metadata),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function mapFileChange(row: Row): HubFileChangeDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId,
    artifactId: row.artifactId ?? null,
    producingEventId: row.producingEventId ?? null,
    path: row.path,
    oldPath: row.oldPath ?? null,
    changeType: row.changeType,
    language: row.language ?? null,
    beforeContent: row.beforeContent ?? null,
    beforeSha256: row.beforeSha256 ?? null,
    beforeTruncated: Boolean(row.beforeTruncated),
    afterContent: row.afterContent ?? null,
    afterSha256: row.afterSha256 ?? null,
    afterTruncated: Boolean(row.afterTruncated),
    patch: row.patch ?? null,
    stats: asObject(row.stats),
    metadata: asObject(row.metadata),
    createdAt: iso(row.createdAt),
  };
}

export function mapContextSnapshot(row: Row): HubContextSnapshotDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId ?? null,
    version: row.version,
    tokenBudget: row.tokenBudget,
    tokenCount: row.tokenCount,
    selectedItemIds: Array.isArray(row.selectedItemIds) ? row.selectedItemIds : [],
    snapshotJson: row.snapshotJson as HubContextSnapshotDto["snapshotJson"],
    promptText: row.promptText,
    createdAt: iso(row.createdAt),
  };
}

export function mapLongTermSummary(row: Row): LongTermSummaryDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    seq: row.seq,
    content: row.content ?? "",
    tokenCount: row.tokenCount ?? 0,
    createdAt: iso(row.createdAt),
  };
}
