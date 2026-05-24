import type {
  AgentDto,
  AgentEvent,
  AgentRun,
  ApiErrorDto,
  ConversationDto,
  CreateConversationRequest,
  CreateMessageRequest,
  CreateTeamRequest,
  MessageDto,
  RunSessionRequest,
  SessionDto,
  TeamDto,
  TeamRunDto,
  StartTeamRunRequest,
} from "@agenthub/shared";
import { io, type Socket } from "socket.io-client";

export type SessionSnapshot = {
  session: SessionDto | null;
  events: AgentEvent[];
};

export type RunSessionResponse = {
  session: SessionDto;
  run: AgentRun;
};

export type CancelRunResponse = {
  session: SessionDto;
  run: AgentRun;
};

export type ApiResult<T> =
  | { ok: true; data: T; source: "api" }
  | { ok: false; error: string };

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";

const now = new Date().toISOString();

export const initialEvents: AgentEvent[] = [];

export const initialSession: SessionDto = {
  id: "local-offline-session",
  title: "等待连接后端会话",
  status: "idle",
  agentId: "claude-code-agent",
  runIds: [],
  activeRunIds: [],
  prompt: "帮我写一个前后端分离的架构的todolist系统。",
  output: undefined,
  createdAt: now,
  updatedAt: now,
};

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | ApiErrorDto
        | null;
      return {
        ok: false,
        error: payload?.message ?? `HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      data: (await response.json()) as T,
      source: "api",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Network request failed",
    };
  }
}

// ---- Session ----

export async function runSession(
  prompt: string,
  conversationId?: string,
  mode?: "single" | "team",
  teamId?: string,
): Promise<ApiResult<RunSessionResponse>> {
  const body: RunSessionRequest = { prompt, conversationId, mode, teamId };
  return requestJson<RunSessionResponse>("/api/session/run", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getCurrentSession(): Promise<ApiResult<SessionSnapshot>> {
  const result = await requestJson<SessionDto | SessionSnapshot>(
    "/api/session/current",
  );

  if (!result.ok) {
    return result;
  }

  if ("session" in result.data) {
    return {
      ok: true,
      data: {
        session: result.data.session,
        events: result.data.events ?? [],
      },
      source: result.source,
    };
  }

  return {
    ok: true,
    data: {
      session: result.data,
      events: [],
    },
    source: result.source,
  };
}

export async function cancelAgentRun(
  runId: string,
): Promise<ApiResult<CancelRunResponse>> {
  return requestJson<CancelRunResponse>(
    `/api/agent-runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

// ---- Conversations ----

export async function listConversations(): Promise<ApiResult<{ items: ConversationDto[] }>> {
  return requestJson<{ items: ConversationDto[] }>("/api/conversations");
}

export async function createConversation(
  body: CreateConversationRequest,
): Promise<ApiResult<ConversationDto>> {
  return requestJson<ConversationDto>("/api/conversations", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getConversation(id: string): Promise<ApiResult<ConversationDto>> {
  return requestJson<ConversationDto>(`/api/conversations/${encodeURIComponent(id)}`);
}

export async function deleteConversation(id: string): Promise<ApiResult<{ ok: boolean }>> {
  return requestJson<{ ok: boolean }>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function listMessages(
  conversationId: string,
): Promise<ApiResult<{ conversationId: string; items: MessageDto[] }>> {
  return requestJson<{ conversationId: string; items: MessageDto[] }>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
}

export async function createMessage(
  conversationId: string,
  body: CreateMessageRequest,
): Promise<ApiResult<MessageDto>> {
  return requestJson<MessageDto>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

// ---- Agents ----

export async function listAgents(): Promise<ApiResult<{ items: AgentDto[] }>> {
  return requestJson<{ items: AgentDto[] }>("/api/agents");
}

export async function createAgent(
  body: Omit<AgentDto, "id" | "createdAt">,
): Promise<ApiResult<AgentDto>> {
  return requestJson<AgentDto>("/api/agents", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getAgent(id: string): Promise<ApiResult<AgentDto>> {
  return requestJson<AgentDto>(`/api/agents/${encodeURIComponent(id)}`);
}

// ---- Teams ----

export async function listTeams(): Promise<ApiResult<{ items: TeamDto[] }>> {
  return requestJson<{ items: TeamDto[] }>("/api/teams");
}

export async function createTeam(
  body: CreateTeamRequest,
): Promise<ApiResult<TeamDto>> {
  return requestJson<TeamDto>("/api/teams", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getTeam(id: string): Promise<ApiResult<TeamDto>> {
  return requestJson<TeamDto>(`/api/teams/${encodeURIComponent(id)}`);
}

export async function startTeamRun(
  teamId: string,
  body: StartTeamRunRequest,
): Promise<ApiResult<TeamRunDto>> {
  return requestJson<TeamRunDto>(`/api/teams/${encodeURIComponent(teamId)}/run`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---- Socket ----

export function joinConversation(
  socket: Socket | null,
  conversationId: string | null,
) {
  if (socket && conversationId) {
    socket.emit("joinConversation", { conversationId });
  }
}

export function connectSessionSocket(
  conversationId: string | null,
  onEvent: (event: AgentEvent) => void,
  onStatus: (status: "connected" | "disconnected" | "unavailable") => void,
): () => void {
  let socket: Socket | null = null;

  try {
    socket = io(API_BASE_URL || undefined, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      reconnectionAttempts: 3,
    });
  } catch {
    onStatus("unavailable");
    return () => undefined;
  }

  socket.on("connect", () => {
    onStatus("connected");
    joinConversation(socket, conversationId);
  });
  socket.on("disconnect", () => onStatus("disconnected"));
  socket.on("connect_error", () => onStatus("unavailable"));
  socket.on("AgentEvent", (event: AgentEvent) => onEvent(event));
  socket.on("agent:event", (event: AgentEvent) => onEvent(event));
  socket.on("session:event", (event: AgentEvent) => onEvent(event));

  if (socket.connected) {
    joinConversation(socket, conversationId);
  }

  return () => {
    socket?.disconnect();
  };
}
