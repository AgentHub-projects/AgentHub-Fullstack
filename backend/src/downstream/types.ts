/**
 * Internal types for the AgentHub <-> Downstream Orchestrator boundary.
 *
 * The downstream "North" protocol is JSON-RPC 2.0 over Socket.IO. We decouple
 * three layers explicitly:
 *
 *   transport          - opaque, message-oriented duplex pipe (frames in/out)
 *   north-adapter      - JSON-RPC client over a transport (pending request
 *                        map, server-initiated requests, timeouts)
 *   session-manager    - higher-level domain logic: bind AgentHub sessions to
 *                        downstream sessions, persist bindings, persist events
 *                        before acking, surface connection errors as run
 *                        failures.
 *
 * Implementing the actual remote downstream worker scheduling is explicitly
 * out of scope here (see issue AGE-5). The surface defined in this module is
 * what the worker layer will plug into.
 */

import type {
  DownstreamConnectionState,
  DownstreamSessionDto,
  DownstreamMention,
  DownstreamPinnedContextItem,
  DownstreamSessionEventDto
} from "@agenthub/shared";

export type { DownstreamConnectionState, DownstreamSessionDto, DownstreamMention, DownstreamPinnedContextItem, DownstreamSessionEventDto };

// --- JSON-RPC 2.0 frames ---

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponseSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

export interface JsonRpcResponseError {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcResponseSuccess | JsonRpcResponseError;

export type JsonRpcFrame = JsonRpcRequest | JsonRpcResponse;

export function isJsonRpcRequest(frame: unknown): frame is JsonRpcRequest {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (frame as { method?: unknown }).method === "string" &&
    typeof (frame as { id?: unknown }).id === "number"
  );
}

export function isJsonRpcResponse(frame: unknown): frame is JsonRpcResponse {
  if (
    typeof frame !== "object" ||
    frame === null ||
    (frame as { jsonrpc?: unknown }).jsonrpc !== "2.0"
  ) {
    return false;
  }
  const f = frame as { id?: unknown; result?: unknown; error?: unknown };
  if (typeof f.id !== "number") return false;
  return "result" in f || "error" in f;
}

// --- Method names (North protocol) ---

export const NorthMethod = {
  Initialize: "initialize",
  SessionNew: "session/new",
  SessionLoad: "session/load",
  SessionPrompt: "session/prompt",
  SessionCancel: "session/cancel",
  /** Server -> client JSON-RPC *request*. Client must respond after persisting. */
  SessionEvent: "session/event"
} as const;

// --- Method param/result shapes ---

export interface InitializeParams {
  client: { name: string; version: string };
}
export interface InitializeResult {
  server: { name: string; protocol: string; version: string };
}

export interface SessionNewParams {
  agentHubSessionId: string;
  agentId: string;
  title?: string;
}
export interface SessionNewResult {
  downstreamSessionId: string;
}

export interface SessionLoadParams {
  downstreamSessionId: string;
}
export interface SessionLoadResult {
  ok: true;
}

export interface SessionPromptParams {
  downstreamSessionId: string;
  runId: string;
  prompt: string;
  mentions?: DownstreamMention[];
  context?: DownstreamPinnedContextItem[];
}
export interface SessionPromptResult {
  ok: true;
}

export interface SessionCancelParams {
  downstreamSessionId: string;
  runId: string;
}
export interface SessionCancelResult {
  ok: true;
}

export interface SessionEventParams extends DownstreamSessionEventDto {
  agentHubSessionId: string;
  downstreamSessionId: string;
  agentId: string;
}
export interface SessionEventResult {
  acked: true;
  eventId: string;
}

// --- Errors ---

export class DownstreamError extends Error {
  constructor(public readonly code: string, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DownstreamError";
  }
}

export const DownstreamErrorCode = {
  Timeout: "DOWNSTREAM_TIMEOUT",
  TransportClosed: "DOWNSTREAM_TRANSPORT_CLOSED",
  Protocol: "DOWNSTREAM_PROTOCOL_ERROR",
  Persistence: "DOWNSTREAM_PERSIST_FAILED",
  Remote: "DOWNSTREAM_REMOTE_ERROR"
} as const;
