import type { Socket } from "socket.io-client";
import type { AgentId } from "@agenthub/shared";
import type { AcpConnection } from "../services/acp-connection";

/** 下游 Socket.IO 连接记录 */
export type ConnectionRecord = {
  key: string;
  socket: Socket;
  acp: AcpConnection;
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
};

/** ACP 协议消息信封 */
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
