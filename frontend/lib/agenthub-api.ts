import type {
  AgentEvent,
  AgentRun,
  ApiErrorDto,
  RunSessionRequest,
  SessionDto,
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
  | { ok: true; data: T; source: "api" | "mock" }
  | { ok: false; error: string };

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";

export const initialEvents: AgentEvent[] = [
  {
    eventId: "mock-evt-1",
    type: "agent_started",
    runId: "mock-run",
    conversationId: "mock-session",
    agentId: "frontend-agent",
    payload: { message: "等待后端会话数据，当前展示本地占位事件。" },
    seq: 1,
    ts: Date.now() - 120000,
  },
  {
    eventId: "mock-evt-2",
    type: "preview_card",
    runId: "mock-run",
    conversationId: "mock-session",
    agentId: "frontend-agent",
    payload: { title: "Preview placeholder", status: "idle" },
    seq: 2,
    ts: Date.now() - 60000,
  },
];

export const initialSession: SessionDto = {
  id: "mock-session",
  title: "P0 前端工作台占位会话",
  status: "idle",
  agentId: "frontend-agent",
  runIds: ["mock-run"],
  prompt: "输入测试口令后将调用 POST /api/session/run",
  output: "后端未连接时，界面会保留本地占位数据并继续允许操作。",
  testSync: {
    status: "pending",
    targetBranch: "main",
  },
  createdAt: new Date(Date.now() - 180000).toISOString(),
  updatedAt: new Date().toISOString(),
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

export async function runSession(
  prompt: string,
): Promise<ApiResult<RunSessionResponse>> {
  const body: RunSessionRequest = { prompt };
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
