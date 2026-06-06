import type {
  AgentInstanceDto,
  AgentTemplateDto,
  ApplyFileChangeResponse,
  BuildMessageDto,
  BuildSessionDto,
  ConfirmBuildRequest,
  ConfirmBuildResponse,
  CreateAgentTemplateRequest,
  CreateHubSessionRequest,
  CreateSessionAgentRequest,
  FrontendRealtimeEnvelope,
  FilesystemChangedEventDto,
  FilesystemEntryDto,
  FilesystemReadFileDto,
  FilesystemSocketAck,
  FilesystemTextEditDto,
  FilesystemUpdateFileDto,
  HubArtifactDto,
  HubArtifactVersionDto,
  HubEventDto,
  HubFileChangeDto,
  HubMessageDto,
  HubRunDto,
  HubSessionDto,
  ListBuildSessionsResponse,
  PinHubMessageRequest,
  DeploymentPreflightResponse,
  ProjectDto,
  SandboxFilesystemConnectionResponse,
  SendBuildMessageRequest,
  SendBuildMessageResponse,
  SendHubMessageRequest,
  SendHubMessageResponse,
  SessionDetailDto,
  SessionDiffContextDto,
  StartDeploymentResponse,
  StartBuildRequest,
  StartBuildResponse,
  UpdateHubSessionRequest,
  UpdateAgentRequest,
  UpdateAgentTemplateRequest,
  CreateProjectRequest,
  UpdateProjectRequest,
  UploadedAttachmentDto,
} from "@agenthub/shared";
import { io, type Socket } from "socket.io-client";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };
export type SocketState = "connecting" | "connected" | "disconnected" | "unavailable";

const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3001";
const API_BASE_URL = RAW_API_BASE.endsWith("/api") ? RAW_API_BASE : `${RAW_API_BASE}/api`;
const SOCKET_URL = RAW_API_BASE.replace(/\/api$/, "");
const FILESYSTEM_SOCKET_ORIGIN = process.env.NEXT_PUBLIC_DOWNSTREAM_FILESYSTEM_ORIGIN?.replace(/\/$/, "") ?? "";

export type MainGitFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface MainGitCommitDto {
  commitSha: string;
  committedAt: string;
  comment: string;
}

export interface MainGitCommitsResponse {
  branchName: "main" | string;
  items: MainGitCommitDto[];
  hasMore: boolean;
  nextCursor: string;
}

export interface MainGitDiffFileSummary {
  path: string;
  oldPath?: string;
  status: MainGitFileStatus;
  additions: number;
  deletions: number;
}

export interface MainGitDiffFilesResponse {
  branchName: "main" | string;
  commitSha: string;
  parentCommitSha: string;
  files: MainGitDiffFileSummary[];
}

export interface MainGitFileDiffResponse {
  branchName: "main" | string;
  commitSha: string;
  parentCommitSha: string;
  path: string;
  oldPath: string;
  status: MainGitFileStatus;
  baseFile: {
    path: string;
    exists: boolean;
    content: string | null;
    isBinary: boolean;
  };
  patch: string;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      return { ok: false, error: payload?.message ?? `HTTP ${response.status}` };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Network request failed" };
  }
}

async function requestMainGitJson<T>(path: string, sessionId: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("sessionId", sessionId);
    const response = await fetch(url.toString(), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
      return { ok: false, error: payload?.message ?? payload?.code ?? `HTTP ${response.status}` };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Network request failed" };
  }
}

export function mainGitCommitsPath(options: { limit?: number; cursor?: string } = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor?.trim()) params.set("cursor", options.cursor.trim());
  const suffix = params.size ? `?${params.toString()}` : "";
  return `/filesystem/git/main/commits${suffix}`;
}

export function mainGitDiffFilesPath(commitSha: string) {
  return `/filesystem/git/main/commits/${encodeURIComponent(commitSha)}/diff/files`;
}

export function mainGitFileDiffPath(commitSha: string, path: string) {
  const params = new URLSearchParams({ path });
  return `/filesystem/git/main/commits/${encodeURIComponent(commitSha)}/diff/file?${params.toString()}`;
}

export function listMainGitCommits(sessionId: string, options: { limit?: number; cursor?: string } = {}) {
  return requestMainGitJson<MainGitCommitsResponse>(mainGitCommitsPath(options), sessionId);
}

export function listMainGitCommitFiles(sessionId: string, commitSha: string) {
  return requestMainGitJson<MainGitDiffFilesResponse>(mainGitDiffFilesPath(commitSha), sessionId);
}

export function getMainGitFileDiff(sessionId: string, commitSha: string, path: string) {
  return requestMainGitJson<MainGitFileDiffResponse>(mainGitFileDiffPath(commitSha, path), sessionId);
}

export function artifactContentUrl(artifactId: string) {
  return `${API_BASE_URL}/artifacts/${encodeURIComponent(artifactId)}/content`;
}

export function listArtifactVersions(artifactId: string) {
  return requestJson<{ items: HubArtifactVersionDto[] }>(`/artifacts/${encodeURIComponent(artifactId)}/versions`);
}

export function getAuthState() {
  return requestJson<{ authenticated: boolean; configured: boolean; user?: { userId: string; username: string } | null }>(
    "/auth/me",
  );
}

export function loginWithCredentials(username: string, password: string) {
  return requestJson<{ authenticated: boolean; user: { userId: string; username: string } }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logoutAuthSession() {
  return requestJson<{ authenticated: boolean }>("/auth/logout", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function listSessions(options: { query?: string; includeArchived?: boolean } = {}) {
  const params = new URLSearchParams();
  if (options.query?.trim()) params.set("q", options.query.trim());
  if (options.includeArchived) params.set("includeArchived", "true");
  const suffix = params.size ? `?${params.toString()}` : "";
  return requestJson<{ items: HubSessionDto[] }>(`/sessions${suffix}`);
}

export function createSession(body: CreateHubSessionRequest) {
  return requestJson<HubSessionDto>("/sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getSessionDetail(sessionId: string) {
  return requestJson<SessionDetailDto>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export function getSessionDiffContext(sessionId: string) {
  return requestJson<SessionDiffContextDto>(`/sessions/${encodeURIComponent(sessionId)}/diff-context`);
}

export function updateSession(sessionId: string, body: UpdateHubSessionRequest) {
  return requestJson<HubSessionDto>(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function archiveSession(sessionId: string) {
  return requestJson<HubSessionDto>(`/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function deleteSession(sessionId: string) {
  return requestJson<HubSessionDto>(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export function bindSessionProject(sessionId: string, projectId: string | null) {
  return requestJson<HubSessionDto>(`/sessions/${encodeURIComponent(sessionId)}/project`, {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });
}

export function listProjects() {
  return requestJson<{ items: ProjectDto[] }>("/projects");
}

export function createProject(body: CreateProjectRequest) {
  return requestJson<ProjectDto>("/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateProject(projectId: string, body: UpdateProjectRequest) {
  return requestJson<ProjectDto>(`/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteProject(projectId: string) {
  return requestJson<{ ok: boolean }>(`/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
}

export function sendSessionMessage(sessionId: string, body: SendHubMessageRequest) {
  return requestJson<SendHubMessageResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function uploadSessionAttachment(sessionId: string, file: File): Promise<ApiResult<UploadedAttachmentDto>> {
  try {
    const response = await fetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/uploads`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      return { ok: false, error: payload?.message ?? `HTTP ${response.status}` };
    }
    return { ok: true, data: (await response.json()) as UploadedAttachmentDto };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Upload failed" };
  }
}

export function pinSessionMessage(sessionId: string, messageId: string, body: PinHubMessageRequest) {
  return requestJson<HubMessageDto>(
    `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/pin`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export function regenerateSessionMessage(sessionId: string, messageId: string) {
  return requestJson<SendHubMessageResponse>(
    `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/regenerate`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function cancelRun(sessionId: string, runId: string) {
  return requestJson<{ runId: string; status: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function applyFileChange(sessionId: string, fileChangeId: string) {
  return requestJson<ApplyFileChangeResponse>(
    `/sessions/${encodeURIComponent(sessionId)}/file-changes/${encodeURIComponent(fileChangeId)}/apply`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function getSandboxFilesystemConnection(sessionId: string) {
  return requestJson<SandboxFilesystemConnectionResponse>(
    `/sessions/${encodeURIComponent(sessionId)}/sandbox/filesystem`,
  );
}

export type SandboxFilesystemClient = {
  list: (path?: string, depth?: number) => Promise<ApiResult<{ entries: FilesystemEntryDto[] }>>;
  read: (path: string, lineStart?: number, lineEnd?: number) => Promise<ApiResult<FilesystemReadFileDto>>;
  update: (input: {
    path: string;
    expectedVersion?: string | null;
    edits: FilesystemTextEditDto[];
    createDirs?: boolean;
  }) => Promise<ApiResult<FilesystemUpdateFileDto>>;
  disconnect: () => void;
};

export function connectSandboxFilesystemSocket(
  connection: SandboxFilesystemConnectionResponse,
  options: {
    branch?: string;
    onState?: (state: SocketState) => void;
    onChanged?: (event: FilesystemChangedEventDto) => void;
  } = {},
): SandboxFilesystemClient {
  const query: Record<string, string> = { sessionId: connection.downstreamSessionId };
  if (options.branch?.trim()) query.branch = options.branch.trim();
  const origin = filesystemSocketOrigin();
  logFilesystem("connect:start", {
    origin,
    downstreamSessionId: connection.downstreamSessionId,
    branch: query.branch ?? "main(default)",
    path: "/filesystem/socket.io",
    query,
  });

  const socket = io(origin, {
    path: "/filesystem/socket.io",
    transports: ["websocket", "polling"],
    query,
  });

  const ready = new Promise<ApiResult<void>>((resolve) => {
    socket.once("connect", () => {
      logFilesystem("connect:ok", {
        socketId: socket.id,
        downstreamSessionId: connection.downstreamSessionId,
        branch: query.branch ?? "main(default)",
      });
      options.onState?.("connected");
      resolve({ ok: true, data: undefined });
    });
    socket.once("connect_error", (error) => {
      logFilesystem("connect:error", {
        downstreamSessionId: connection.downstreamSessionId,
        message: error instanceof Error ? error.message : String(error),
      });
      options.onState?.("unavailable");
      resolve({ ok: false, error: error instanceof Error ? error.message : "Filesystem socket unavailable" });
    });
  });

  options.onState?.("connecting");
  socket.on("disconnect", (reason) => {
    logFilesystem("disconnect", { downstreamSessionId: connection.downstreamSessionId, reason });
    options.onState?.("disconnected");
  });
  socket.on("fs:changed", (event: FilesystemChangedEventDto) => {
    logFilesystem("event:fs:changed", { downstreamSessionId: connection.downstreamSessionId, event });
    options.onChanged?.(event);
  });

  return {
    list: (path = ".", depth = 1) =>
      emitFilesystemAck(socket, ready, "fs:list", connection.downstreamSessionId, {
        requestId: requestId("list"),
        path: path || ".",
        depth,
      }),
    read: (path, lineStart = 0, lineEnd = 0) =>
      emitFilesystemAck(socket, ready, "fs:read", connection.downstreamSessionId, {
        requestId: requestId("read"),
        path,
        lineStart,
        lineEnd,
      }),
    update: (input) =>
      emitFilesystemAck(socket, ready, "fs:update", connection.downstreamSessionId, {
        requestId: requestId("update"),
        path: input.path,
        expectedVersion: input.expectedVersion || undefined,
        edits: input.edits,
        createDirs: input.createDirs,
      }),
    disconnect: () => socket.disconnect(),
  };
}

export function connectMainGitSocket(sessionId: string, handlers: {
  onState?: (state: SocketState) => void;
  onCommitted?: () => void;
}) {
  let socket: Socket | null = null;
  try {
    socket = io(filesystemSocketOrigin(), {
      path: "/filesystem/socket.io",
      query: { sessionId },
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
    });
  } catch {
    handlers.onState?.("unavailable");
    return () => undefined;
  }

  handlers.onState?.("connecting");
  socket.on("connect", () => handlers.onState?.("connected"));
  socket.on("disconnect", () => handlers.onState?.("disconnected"));
  socket.on("connect_error", () => handlers.onState?.("unavailable"));
  socket.on("main:committed", () => handlers.onCommitted?.());

  return () => {
    socket?.disconnect();
  };
}

async function emitFilesystemAck<T>(
  socket: Socket,
  ready: Promise<ApiResult<void>>,
  event: "fs:list" | "fs:read" | "fs:update",
  downstreamSessionId: string,
  payload: Record<string, unknown>,
): Promise<ApiResult<T>> {
  const connected = socket.connected ? { ok: true, data: undefined } as const : await ready;
  if (!connected.ok) return connected;
  logFilesystem("request", { downstreamSessionId, event, payload });

  return new Promise((resolve) => {
    socket.timeout(15000).emit(event, payload, (error: Error | null, response?: FilesystemSocketAck<T>) => {
      if (error) {
        logFilesystem("response:error", { downstreamSessionId, event, message: error.message });
        resolve({ ok: false, error: error.message || "Filesystem socket timeout" });
        return;
      }
      if (!response) {
        logFilesystem("response:empty", { downstreamSessionId, event });
        resolve({ ok: false, error: "Filesystem socket returned empty response" });
        return;
      }
      if (!response.ok) {
        logFilesystem("response:failed", { downstreamSessionId, event, response });
        resolve({ ok: false, error: response.error.message || response.error.code });
        return;
      }
      logFilesystem("response:ok", { downstreamSessionId, event, response });
      resolve({ ok: true, data: response.data });
    });
  });
}

function requestId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function logFilesystem(stage: string, details: Record<string, unknown>) {
  console.info(`[filesystem] ${stage}`, details);
}

function filesystemSocketOrigin() {
  if (FILESYSTEM_SOCKET_ORIGIN) return FILESYSTEM_SOCKET_ORIGIN;
  if (typeof window !== "undefined") return window.location.origin;
  return SOCKET_URL;
}

export function startDeployment(sessionId: string) {
  return requestJson<StartDeploymentResponse>(`/sessions/${encodeURIComponent(sessionId)}/deployments`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function getDeploymentPreflight(sessionId: string) {
  return requestJson<DeploymentPreflightResponse>(
    `/sessions/${encodeURIComponent(sessionId)}/deployments/preflight`,
  );
}

export function listAgents() {
  return requestJson<{ items: AgentInstanceDto[] }>("/agents");
}

export function createSessionAgent(body: CreateSessionAgentRequest) {
  return requestJson<AgentInstanceDto>("/agents", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateAgent(id: string | number, body: UpdateAgentRequest) {
  return requestJson<AgentInstanceDto>(`/agents/${encodeURIComponent(String(id))}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteAgent(id: string | number) {
  return requestJson<{ ok: boolean }>(`/agents/${encodeURIComponent(String(id))}`, {
    method: "DELETE",
  });
}

export function listAgentTemplates() {
  return requestJson<AgentTemplateDto[]>("/agent-templates");
}

// ---- Agent Template CRUD ----

export function createAgentTemplate(body: CreateAgentTemplateRequest) {
  return requestJson<AgentTemplateDto>("/agent-templates", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateAgentTemplate(id: number, body: UpdateAgentTemplateRequest) {
  return requestJson<AgentTemplateDto>(`/agent-templates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteAgentTemplate(id: number) {
  return requestJson<{ ok: boolean }>(`/agent-templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ---- Builder ----

export function listBuildSessions() {
  return requestJson<ListBuildSessionsResponse>("/agent-templates/build");
}

export function startBuild(body: StartBuildRequest) {
  return requestJson<StartBuildResponse>("/agent-templates/build/start", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function sendBuildMessage(buildId: string, body: SendBuildMessageRequest) {
  return requestJson<SendBuildMessageResponse>(
    `/agent-templates/build/${encodeURIComponent(buildId)}/messages`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function confirmBuild(buildId: string, body: ConfirmBuildRequest) {
  return requestJson<ConfirmBuildResponse>(
    `/agent-templates/build/${encodeURIComponent(buildId)}/confirm`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function getBuildSession(buildId: string) {
  return requestJson<BuildSessionDto>(
    `/agent-templates/build/${encodeURIComponent(buildId)}`,
  );
}

export function getBuildMessages(buildId: string) {
  return requestJson<BuildMessageDto[]>(
    `/agent-templates/build/${encodeURIComponent(buildId)}/messages`,
  );
}

export function connectHubSocket(
  sessionId: string | string[] | null,
  handlers: {
    onState: (state: SocketState) => void;
    onEvent: (event: HubEventDto) => void;
    onSession: (session: HubSessionDto) => void;
    onMessage?: (message: HubMessageDto) => void;
    onArtifact: (artifact: HubArtifactDto) => void;
    onFileChange: (fileChange: HubFileChangeDto) => void;
  },
) {
  let socket: Socket | null = null;
  try {
    socket = io(SOCKET_URL, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
      withCredentials: true,
    });
  } catch {
    handlers.onState("unavailable");
    return () => undefined;
  }

  socket.on("connect", () => {
    handlers.onState("connected");
    for (const id of normalizeSessionIds(sessionId)) socket?.emit("session.subscribe", { sessionId: id });
  });
  socket.on("disconnect", () => handlers.onState("disconnected"));
  socket.on("connect_error", () => handlers.onState("unavailable"));
  socket.on("hub:event", (envelope: FrontendRealtimeEnvelope) => {
    if (envelope.type === "event") handlers.onEvent(envelope.payload as HubEventDto);
  });
  socket.on("hub:session", (envelope: FrontendRealtimeEnvelope) => {
    if (envelope.type === "session") handlers.onSession(envelope.payload as HubSessionDto);
  });
  socket.on("hub:message", (envelope: FrontendRealtimeEnvelope) => {
    if (envelope.type === "message") handlers.onMessage?.(envelope.payload as HubMessageDto);
  });
  socket.on("hub:artifact", (envelope: FrontendRealtimeEnvelope) => {
    if (envelope.type === "artifact") handlers.onArtifact(envelope.payload as HubArtifactDto);
  });
  socket.on("hub:file_change", (envelope: FrontendRealtimeEnvelope) => {
    if (envelope.type === "file_change") handlers.onFileChange(envelope.payload as HubFileChangeDto);
  });

  return () => {
    socket?.disconnect();
  };
}

function normalizeSessionIds(sessionId: string | string[] | null) {
  if (!sessionId) return [];
  return Array.isArray(sessionId) ? sessionId.filter(Boolean) : [sessionId];
}

export type TimelineItem =
  | { kind: "message"; id: string; ts: string; message: HubMessageDto }
  | { kind: "event"; id: string; ts: string; event: HubEventDto };

export function buildTimeline(messages: HubMessageDto[], events: HubEventDto[]): TimelineItem[] {
  return [
    ...messages.map((message) => ({ kind: "message" as const, id: message.id, ts: message.createdAt, message })),
    ...events.map((event) => ({
      kind: "event" as const,
      id: event.id,
      ts: event.occurredAt ?? event.persistedAt,
      event,
    })),
  ].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

export function upsertById<T extends { id: string | number }>(items: T[], item: T) {
  const next = items.filter((current) => current.id !== item.id);
  next.push(item);
  return next;
}
