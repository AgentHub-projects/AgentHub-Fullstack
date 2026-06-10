import type {
  AgentTemplateDto,
  HubArtifactDto,
  HubArtifactKind,
  HubEventDto,
  HubFileChangeDto,
  HubMessageDto,
  HubRunDto,
  HubSessionDto,
} from "@agenthub/shared";

export function formatElapsed(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase() || "AI";
}

export function agentColor(seed: string | number) {
  const colors = ["#2c6d67", "#365f91", "#8a5b2c", "#7d476d", "#56633f", "#8a3f3f"];
  let hash = 0;
  for (const char of String(seed)) hash = char.charCodeAt(0) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export function artifactLabel(kind: HubArtifactKind) {
  if (kind === "markdown" || kind === "text") return "markdown";
  if (kind === "pdf" || kind === "docx" || kind === "pptx") return "document";
  return "code";
}

export type FileChangeApplyStatus = "queued" | "applied" | "failed" | "conflict";

export function fileChangeApplyStatus(change: HubFileChangeDto): FileChangeApplyStatus | null {
  const value = change.metadata.applyStatus;
  if (value === "queued" || value === "applied" || value === "failed" || value === "conflict") return value;
  return null;
}

export function fileChangeApplyLabel(status: FileChangeApplyStatus) {
  if (status === "queued") return "等待应用";
  if (status === "applied") return "已应用";
  if (status === "conflict") return "有冲突";
  return "应用失败";
}

export function fileChangeApplyMessage(change: HubFileChangeDto) {
  const message = change.metadata.applyMessage;
  if (typeof message === "string" && message.trim()) return message.trim();
  const conflicts = change.metadata.applyConflicts;
  if (Array.isArray(conflicts) && conflicts.length > 0) return `检测到 ${conflicts.length} 个冲突`;
  return "";
}

export function isRunning(status: string) {
  return status === "queued" || status === "context_building" || status === "connecting" || status === "running";
}

export function readMemberAgentIds(session: HubSessionDto | null | undefined) {
  const value = session?.metadata.memberAgentIds;
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "number" ? item : typeof item === "string" && /^\d+$/.test(item) ? Number(item) : null))
    .filter((item): item is number => item !== null);
}

export function readDirectAgentId(session: HubSessionDto | null | undefined) {
  return readNumericMetadata(session, "directAgentId");
}

export function readOrchestratorAgentId(session: HubSessionDto | null | undefined) {
  return readNumericMetadata(session, "orchestratorAgentId");
}

export function sessionMode(session: HubSessionDto | null | undefined) {
  return session?.metadata.mode === "direct" || readDirectAgentId(session) ? "direct" : "group";
}

function readNumericMetadata(session: HubSessionDto | null | undefined, key: string) {
  const value = session?.metadata[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function buildGroupTitle(templateIds: number[], templates: AgentTemplateDto[]) {
  const names = templateIds
    .map((id) => templates.find((tpl) => tpl.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return "新 Agent 群聊";
  return `Agent 群聊 · ${names.slice(0, 3).join("、")}${names.length > 3 ? ` 等 ${names.length} 个` : ""}`;
}

export function sessionSubtitle(session: HubSessionDto) {
  const memberCount = readMemberAgentIds(session).length;
  const status = session.status === "archived" ? "archived" : session.lastRun?.status ?? session.status;
  return `${memberCount ? `${memberCount} 个 Agent · ` : ""}${status} · ${formatTime(session.updatedAt)}`;
}

export function sortSession(a: HubSessionDto, b: HubSessionDto) {
  const pinnedDiff = Number(b.isPinned) - Number(a.isPinned);
  if (pinnedDiff !== 0) return pinnedDiff;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function sortMessage(a: HubMessageDto, b: HubMessageDto) {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export function sortRun(a: HubRunDto, b: HubRunDto) {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

export function sortEvent(a: HubEventDto, b: HubEventDto) {
  return a.seq - b.seq || new Date(a.persistedAt).getTime() - new Date(b.persistedAt).getTime();
}

export function sortArtifact(a: HubArtifactDto, b: HubArtifactDto) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

export function sortFileChange(a: HubFileChangeDto, b: HubFileChangeDto) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}
