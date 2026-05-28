import type {
  AgentInstanceDto,
  AgentTemplateDto,
  CreateHubSessionRequest,
  FrontendRealtimeEnvelope,
  HubArtifactDto,
  HubContextSnapshotDto,
  HubEventDto,
  HubFileChangeDto,
  HubMessageDto,
  HubRunDto,
  HubSessionDto,
  PinHubMessageRequest,
  SendHubMessageRequest,
  SendHubMessageResponse,
  SessionDetailDto,
} from "@agenthub/shared";
import { io, type Socket } from "socket.io-client";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };
export type SocketState = "connecting" | "connected" | "disconnected" | "unavailable";

const RAW_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3001";
const API_BASE_URL = RAW_API_BASE.endsWith("/api") ? RAW_API_BASE : `${RAW_API_BASE}/api`;
const SOCKET_URL = RAW_API_BASE.replace(/\/api$/, "");

async function requestJson<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
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

export function artifactContentUrl(artifactId: string) {
  return `${API_BASE_URL}/artifacts/${encodeURIComponent(artifactId)}/content`;
}

export function listSessions() {
  return requestJson<{ items: HubSessionDto[] }>("/sessions");
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

export function sendSessionMessage(sessionId: string, body: SendHubMessageRequest) {
  return requestJson<SendHubMessageResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
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

export function cancelRun(sessionId: string, runId: string) {
  return requestJson<{ runId: string; status: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export function listAgents() {
  return requestJson<{ items: AgentInstanceDto[] }>("/agents");
}

export function listAgentTemplates() {
  return requestJson<{ items: AgentTemplateDto[] }>("/agents/templates");
}

export function connectHubSocket(
  sessionId: string | null,
  handlers: {
    onState: (state: SocketState) => void;
    onEvent: (event: HubEventDto) => void;
    onSession: (session: HubSessionDto) => void;
    onArtifact: (artifact: HubArtifactDto) => void;
    onFileChange: (fileChange: HubFileChangeDto) => void;
    onContext: (context: HubContextSnapshotDto) => void;
  },
) {
  let socket: Socket | null = null;
  try {
    socket = io(SOCKET_URL, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 5,
    });
  } catch {
    handlers.onState("unavailable");
    return () => undefined;
  }

  socket.on("connect", () => {
    handlers.onState("connected");
    if (sessionId) socket?.emit("session.subscribe", { sessionId });
  });
  socket.on("disconnect", () => handlers.onState("disconnected"));
  socket.on("connect_error", () => handlers.onState("unavailable"));
  socket.on("hub:event", (envelope: FrontendRealtimeEnvelope) => {
    if (envelope.type === "event") handlers.onEvent(envelope.payload as HubEventDto);
  });
  socket.on("hub:session", (envelope: FrontendRealtimeEnvelope) => {
    if (envelope.type === "session") handlers.onSession(envelope.payload as HubSessionDto);
  });
  socket.on("hub:artifact", (envelope: FrontendRealtimeEnvelope) => {
    if (envelope.type === "artifact") handlers.onArtifact(envelope.payload as HubArtifactDto);
  });
  socket.on("hub:file_change", (envelope: FrontendRealtimeEnvelope) => {
    if (envelope.type === "file_change") handlers.onFileChange(envelope.payload as HubFileChangeDto);
  });
  socket.on("hub:context", (envelope: FrontendRealtimeEnvelope) => {
    if (envelope.type === "context") handlers.onContext(envelope.payload as HubContextSnapshotDto);
  });

  return () => {
    socket?.disconnect();
  };
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

export function upsertById<T extends { id: string }>(items: T[], item: T) {
  const next = items.filter((current) => current.id !== item.id);
  next.push(item);
  return next;
}
