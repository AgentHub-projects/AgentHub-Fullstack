import type {
  AgentInstanceDto,
  AgentTemplateDto,
  HubArtifactDto,
  HubArtifactVersionDto,
  HubContextSnapshotDto,
  HubEventDto,
  HubFileChangeDto,
  HubMessageDto,
  HubMessagePartDto,
  HubRunDto,
  HubSessionDto,
  ProjectDto,
  DeploymentDto,
} from "@agenthub/shared";

type Row = Record<string, any>;

/** 安全转换为对象，非对象值返回 {} */
export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 安全转换为数组，非数组值返回 [] */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 将 Date/字符串/null 转换为 ISO 字符串，空值返回 epoch */
export function iso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** 将 Date/字符串/null 转换为 ISO 字符串或 null */
export function maybeIso(value: Date | string | null | undefined): string | null {
  return value ? iso(value) : null;
}

/** 将数据库行映射为 AgentTemplateDto */
export function mapTemplate(row: Row, providerNames?: Map<number, string>): AgentTemplateDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    defaultProvider: providerNames?.get(row.defaultProviderId) ?? "claude-code",
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

/** 将数据库行映射为 AgentInstanceDto */
export function mapAgent(row: Row, providerNames?: Map<number, string>): AgentInstanceDto {
  return {
    id: row.id,
    templateId: row.templateId,
    name: row.name,
    avatarUrl: row.avatarUrl ?? null,
    description: row.description ?? "",
    provider: providerNames?.get(row.providerId) ?? "claude-code",
    isDefaultOrchestrator: Boolean(row.isDefaultOrchestrator),
    status: row.status,
    capabilities: asArray(row.template?.defaultCapabilities),
    template: row.template ? mapTemplate(row.template, providerNames) : undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** 将数据库行映射为 HubSessionDto */
export function mapSession(row: Row): HubSessionDto {
  const metadata = asObject(row.metadata);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    isPinned: metadata.isPinned === true,
    projectId: row.projectId ?? null,
    metadata,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    lastRun: row.runs?.[0] ? mapRun(row.runs[0]) : undefined,
  };
}

/** 将数据库行映射为 ProjectDto */
export function mapProject(row: Row): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    githubUrl: row.githubUrl,
    defaultBranch: row.defaultBranch,
    status: row.status,
    metadata: asObject(row.metadata),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** 将数据库行映射为 DeploymentDto */
export function mapDeployment(row: Row): DeploymentDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    projectId: row.projectId,
    triggerMessageId: row.triggerMessageId ?? null,
    commitSha: row.commitSha,
    status: row.status,
    deployServiceJobId: row.deployServiceJobId ?? null,
    url: row.url ?? null,
    errorMessage: row.errorMessage ?? null,
    metadata: asObject(row.metadata),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    completedAt: maybeIso(row.completedAt),
  };
}

/** 将数据库行映射为 HubMessageDto，含 parts 解析 */
export function mapMessage(row: Row): HubMessageDto {
  const contentJson = asObject(row.contentJson);
  const contentText = row.contentText ?? "";
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId ?? null,
    role: row.role,
    agentId: row.agentId ?? null,
    agentName: row.agent?.name ?? null,
    parentMessageId: row.parentMessageId ?? null,
    contentText,
    contentJson,
    parts: messageParts(contentJson, contentText),
    tokenCount: row.tokenCount ?? 0,
    status: row.status ?? "completed",
    isPinned: Boolean(row.isPinned),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** 从 contentJson 和 contentText 提取消息部件数组 */
function messageParts(contentJson: Record<string, unknown>, contentText: string): HubMessagePartDto[] {
  const pinnedPartIds = new Set(
    Array.isArray(contentJson.pinnedPartIds)
      ? contentJson.pinnedPartIds.filter((item): item is string => typeof item === "string")
      : [],
  );
  if (Array.isArray(contentJson.parts)) {
    return contentJson.parts
      .map((item, index) => normalizeMessagePart(item, index, pinnedPartIds))
      .filter((item): item is HubMessagePartDto => Boolean(item));
  }
  return [{ id: "part_1", type: "text", text: contentText, pinned: pinnedPartIds.has("part_1") }];
}

/** 标准化单个消息部件 */
function normalizeMessagePart(value: unknown, index: number, pinnedPartIds: Set<string>): HubMessagePartDto | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const type = typeof row.type === "string" ? row.type : "text";
  const id = typeof row.id === "string" ? row.id : `part_${index + 1}`;
  return {
    id,
    type,
    text: typeof row.text === "string" ? row.text : undefined,
    language: typeof row.language === "string" ? row.language : undefined,
    title: typeof row.title === "string" ? row.title : undefined,
    url: typeof row.url === "string" ? row.url : undefined,
    pinned: pinnedPartIds.has(id),
    metadata: asObject(row.metadata),
  };
}

/** 将数据库行映射为 HubRunDto */
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

/** 将数据库行映射为 HubEventDto */
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

/** 将数据库行映射为 HubArtifactDto */
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

/** 将数据库行映射为 HubArtifactVersionDto */
export function mapArtifactVersion(row: Row): HubArtifactVersionDto {
  return {
    id: row.id,
    artifactId: row.artifactId ?? row.artifact_id,
    version: row.version,
    producingEventId: row.producingEventId ?? row.producing_event_id ?? null,
    title: row.title,
    kind: row.kind,
    mimeType: row.mimeType ?? row.mime_type,
    storageKind: row.storageKind ?? row.storage_kind,
    storageUri: row.storageUri ?? row.storage_uri ?? null,
    textContent: row.textContent ?? row.text_content ?? null,
    sha256: row.sha256 ?? null,
    sizeBytes: row.sizeBytes == null && row.size_bytes == null ? null : Number(row.sizeBytes ?? row.size_bytes),
    final: Boolean(row.final),
    metadata: asObject(row.metadata),
    createdAt: iso(row.createdAt ?? row.created_at),
  };
}

/** 将数据库行映射为 HubFileChangeDto */
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

/** 将数据库行映射为 HubContextSnapshotDto */
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

