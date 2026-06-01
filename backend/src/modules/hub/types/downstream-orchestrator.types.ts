import type { Socket } from "socket.io-client";
import type { AgentId } from "@agenthub/shared";

export type ConnectionRecord = {
  key: string;
  socket: Socket;
  sessionId: string;
  downstreamSessionId?: string;
  downstreamReady?: Promise<string>;
  resolveDownstreamReady?: (id: string) => void;
  rejectDownstreamReady?: (error: Error) => void;
  activeRunId?: string;
  activeOrchestratorAgentId?: AgentId;
  loadedActiveRun?: { runId?: string; status?: string };
  idleTimer: NodeJS.Timeout | null;
  lastActivityAt: number;
  needsBootstrap: boolean;
  closing?: boolean;
  nextId: number;
  pendingRequests: Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
};

export type DownstreamEnvelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number | string; message?: string } | string;
  type?: string;
  runId?: string;
  seq?: number;
  payload?: Record<string, unknown>;
  speaker?: string;
};
