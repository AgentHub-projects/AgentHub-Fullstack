/**
 * MockOrchestrator implements the server side of the North JSON-RPC
 * protocol so AgentHub integration tests can exercise the full
 * adapter / session-manager / persistence path without standing up a real
 * downstream worker.
 *
 * It speaks JSON-RPC 2.0 over a {@link Transport} (typically the `b` side
 * of {@link InMemoryTransport.pair}), implements the same method names as
 * the production orchestrator, and emits realistic `session/event`
 * deltas + completion when given a prompt.
 */

import type { JsonRpcFrame } from "./types";
import {
  DownstreamError,
  DownstreamErrorCode,
  NorthMethod,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type InitializeParams,
  type InitializeResult,
  type SessionCancelParams,
  type SessionCancelResult,
  type SessionEventParams,
  type SessionEventResult,
  type SessionLoadParams,
  type SessionLoadResult,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult
} from "./types";
import type { Transport } from "./transport";

interface MockSession {
  downstreamSessionId: string;
  agentHubSessionId: string;
  agentId: string;
  cancelled: boolean;
}

export interface MockOrchestratorOptions {
  /** Override the deltas emitted in response to `session/prompt`. */
  scriptDeltas?: (input: SessionPromptParams) => string[];
  /** When true, `session/prompt` returns success but emits no events. */
  silent?: boolean;
}

export class MockOrchestrator {
  private readonly sessions = new Map<string, MockSession>();
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextSessionSeq = 1;
  private readonly options: MockOrchestratorOptions;

  constructor(private readonly transport: Transport, options: MockOrchestratorOptions = {}) {
    this.options = options;
    transport.onFrame((frame) => this.handleFrame(frame));
    transport.onClose(() => {
      for (const entry of this.pending.values()) {
        entry.reject(
          new DownstreamError(DownstreamErrorCode.TransportClosed, "mock orchestrator transport closed")
        );
      }
      this.pending.clear();
    });
  }

  /** Force-disconnect (used by tests to assert reconnect/leak behaviour). */
  async disconnect(error?: Error): Promise<void> {
    await this.transport.close(error);
  }

  private handleFrame(frame: JsonRpcFrame): void {
    if (isJsonRpcRequest(frame)) {
      void this.handleClientRequest(frame.id, frame.method, frame.params);
      return;
    }
    if (isJsonRpcResponse(frame)) {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      if ("error" in frame) {
        entry.reject(new DownstreamError(DownstreamErrorCode.Remote, frame.error.message));
        return;
      }
      entry.resolve(frame.result);
    }
  }

  private async handleClientRequest(id: number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.dispatch(method, params);
      await this.transport.send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.transport.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message }
      });
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case NorthMethod.Initialize: {
        const _p = params as InitializeParams;
        const result: InitializeResult = {
          server: { name: "mock-orchestrator", protocol: "north", version: "0.1.0" }
        };
        return result;
      }
      case NorthMethod.SessionNew: {
        const p = params as SessionNewParams;
        const downstreamSessionId = `dwn-${this.nextSessionSeq++}`;
        this.sessions.set(downstreamSessionId, {
          downstreamSessionId,
          agentHubSessionId: p.agentHubSessionId,
          agentId: p.agentId,
          cancelled: false
        });
        const result: SessionNewResult = { downstreamSessionId };
        return result;
      }
      case NorthMethod.SessionLoad: {
        const p = params as SessionLoadParams;
        if (!this.sessions.has(p.downstreamSessionId)) {
          throw new Error(`unknown downstream session ${p.downstreamSessionId}`);
        }
        const result: SessionLoadResult = { ok: true };
        return result;
      }
      case NorthMethod.SessionPrompt: {
        const p = params as SessionPromptParams;
        const session = this.sessions.get(p.downstreamSessionId);
        if (!session) throw new Error(`unknown downstream session ${p.downstreamSessionId}`);
        session.cancelled = false;
        // Schedule the events asynchronously so the prompt RPC resolves
        // first; mirrors how a real worker would queue work.
        void this.streamEvents(session, p);
        const result: SessionPromptResult = { ok: true };
        return result;
      }
      case NorthMethod.SessionCancel: {
        const p = params as SessionCancelParams;
        const session = this.sessions.get(p.downstreamSessionId);
        if (session) session.cancelled = true;
        const result: SessionCancelResult = { ok: true };
        return result;
      }
      default:
        throw new Error(`unsupported method ${method}`);
    }
  }

  private async streamEvents(session: MockSession, prompt: SessionPromptParams): Promise<void> {
    if (this.options.silent) return;
    const deltas =
      this.options.scriptDeltas?.(prompt) ?? defaultScript(prompt);
    let seq = 0;
    for (const text of deltas) {
      if (session.cancelled) {
        await this.emitEvent(session, prompt.runId, ++seq, "agent_cancelled", { runId: prompt.runId });
        return;
      }
      await this.emitEvent(session, prompt.runId, ++seq, "text_delta", { text });
    }
    if (session.cancelled) return;
    await this.emitEvent(session, prompt.runId, ++seq, "agent_completed", { ok: true });
    await this.emitEvent(session, prompt.runId, ++seq, "done", { status: "succeeded" });
  }

  /** Emit a server-initiated `session/event` and wait for the client's ack. */
  async emitEvent(
    session: MockSession,
    runId: string,
    seq: number,
    type: string,
    payload: unknown,
    eventIdOverride?: string
  ): Promise<SessionEventResult> {
    const id = this.nextRequestId++;
    const params: SessionEventParams = {
      agentHubSessionId: session.agentHubSessionId,
      downstreamSessionId: session.downstreamSessionId,
      agentId: session.agentId,
      runId,
      eventId: eventIdOverride ?? `${session.downstreamSessionId}-evt-${seq}`,
      seq,
      ts: Date.now(),
      type,
      payload
    };
    return await new Promise<SessionEventResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as SessionEventResult),
        reject
      });
      this.transport
        .send({ jsonrpc: "2.0", id, method: NorthMethod.SessionEvent, params })
        .catch((err: unknown) => {
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  /** Test helper: re-emit the same event id to verify idempotent ack. */
  async emitDuplicateEvent(
    downstreamSessionId: string,
    runId: string,
    eventId: string
  ): Promise<SessionEventResult> {
    const session = this.sessions.get(downstreamSessionId);
    if (!session) throw new Error(`unknown session ${downstreamSessionId}`);
    return await this.emitEvent(session, runId, 999, "text_delta", { text: "duplicate" }, eventId);
  }
}

function defaultScript(prompt: SessionPromptParams): string[] {
  const trimmed = prompt.prompt.trim();
  return [
    `Working on: ${trimmed.slice(0, 60)}`,
    "...",
    "Done."
  ];
}
