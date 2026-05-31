import type { Socket } from "socket.io-client";
import type { AgentId } from "@agenthub/shared";

export type ConnectionRecord = {
  key: string;
  socket: Socket;
  sessionId: string;
  downstreamSessionId?: string;
  downstreamReady?: Promise<string>;
  resolveDownstreamReady?: (id: string) => void;
  activeRunId?: string;
  activeOrchestratorAgentId?: AgentId;
  idleTimer: NodeJS.Timeout | null;
  lastActivityAt: number;
  needsBootstrap: boolean;
  nextId: number;
};

export type DownstreamEnvelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  type?: string;
  runId?: string;
  seq?: number;
  payload?: Record<string, unknown>;
  speaker?: string;
};
