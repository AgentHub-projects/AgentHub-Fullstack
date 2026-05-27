import type {
  JsonRpcFrame,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcResponseError
} from "./types";
import {
  DownstreamError,
  DownstreamErrorCode,
  isJsonRpcRequest,
  isJsonRpcResponse
} from "./types";
import type { Transport } from "./transport";

export type ServerRequestHandler = (
  method: string,
  params: unknown
) => Promise<unknown>;

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer?: NodeJS.Timeout;
}

export interface NorthAdapterOptions {
  /** Default per-request timeout in ms. Set to 0 to disable. */
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * JSON-RPC 2.0 client over a {@link Transport}.
 *
 * Responsibilities:
 *  - assign monotonically increasing request ids;
 *  - maintain a pending-request map keyed by id;
 *  - reject pending requests with a clear, typed error when the transport
 *    closes (no leaks);
 *  - apply per-request timeouts that also reject pending entries;
 *  - dispatch server-initiated requests to a handler and write the response
 *    back through the transport, reflecting the handler outcome (resolved
 *    -> result, thrown -> JSON-RPC error).
 *
 * The adapter is intentionally agnostic about *what* the server requests are
 * for — domain handling lives in the session manager.
 */
export class NorthAdapter {
  private nextId = 1;
  private readonly pending = new Map<number, PendingEntry>();
  private serverRequestHandler?: ServerRequestHandler;
  private closed = false;
  private closeError?: Error;
  private readonly timeoutMs: number;
  private readonly closeListeners = new Set<(error?: Error) => void>();

  constructor(private readonly transport: Transport, options: NorthAdapterOptions = {}) {
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    transport.onFrame((frame) => this.handleFrame(frame));
    transport.onClose((error) => this.handleTransportClose(error));
  }

  /** Register the handler invoked for each server-initiated JSON-RPC request. */
  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /**
   * Subscribe to transport-close events. Multiple subscribers are
   * supported (the underlying Transport contract only stores a single
   * listener, so the adapter fans out to all subscribers). Used by the
   * bootstrap layer to forward connection loss to the session manager.
   */
  onClose(listener: (error?: Error) => void): void {
    this.closeListeners.add(listener);
    if (this.closed) {
      // Already closed — fire immediately so late subscribers still see
      // the cause instead of silently waiting.
      listener(this.closeError);
    }
  }

  /** Number of in-flight client requests (exposed for tests/leak checks). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Send a JSON-RPC request and resolve with its `result`. Rejects with a
   * {@link DownstreamError} on timeout, transport close, or remote error
   * response.
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw (
        this.closeError ??
        new DownstreamError(DownstreamErrorCode.TransportClosed, "adapter is closed")
      );
    }
    const id = this.nextId++;
    const frame: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return await new Promise<T>((resolve, reject) => {
      const entry: PendingEntry = {
        method,
        resolve: (v) => resolve(v as T),
        reject
      };
      if (this.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          // Drop the entry first so a late response doesn't double-resolve.
          if (this.pending.delete(id)) {
            reject(
              new DownstreamError(
                DownstreamErrorCode.Timeout,
                `JSON-RPC request "${method}" (id ${id}) timed out after ${this.timeoutMs}ms`
              )
            );
          }
        }, this.timeoutMs);
      }
      this.pending.set(id, entry);
      this.transport.send(frame).catch((err: unknown) => {
        if (this.pending.delete(id)) {
          if (entry.timer) clearTimeout(entry.timer);
          reject(
            err instanceof Error
              ? err
              : new DownstreamError(DownstreamErrorCode.TransportClosed, String(err))
          );
        }
      });
    });
  }

  /** Close the adapter; rejects every pending request and closes the transport. */
  async close(error?: Error): Promise<void> {
    if (this.closed) return;
    this.handleTransportClose(error ?? new DownstreamError(DownstreamErrorCode.TransportClosed, "adapter closed"));
    await this.transport.close(error);
  }

  private handleFrame(frame: JsonRpcFrame): void {
    if (isJsonRpcResponse(frame)) {
      this.routeResponse(frame);
      return;
    }
    if (isJsonRpcRequest(frame)) {
      void this.dispatchServerRequest(frame);
      return;
    }
  }

  private routeResponse(frame: JsonRpcResponse): void {
    const entry = this.pending.get(frame.id);
    if (!entry) {
      // Late or duplicate response. Discard quietly — a timeout already
      // rejected the original caller.
      return;
    }
    this.pending.delete(frame.id);
    if (entry.timer) clearTimeout(entry.timer);

    if ("error" in frame) {
      const err = (frame as JsonRpcResponseError).error;
      entry.reject(
        new DownstreamError(
          DownstreamErrorCode.Remote,
          `${entry.method} failed: ${err.message}`,
          err
        )
      );
      return;
    }
    entry.resolve(frame.result);
  }

  private async dispatchServerRequest(frame: JsonRpcRequest): Promise<void> {
    const handler = this.serverRequestHandler;
    if (!handler) {
      const errorFrame: JsonRpcResponseError = {
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: -32601, message: `no handler registered for "${frame.method}"` }
      };
      void this.transport.send(errorFrame).catch(() => undefined);
      return;
    }
    try {
      const result = await handler(frame.method, frame.params);
      await this.transport.send({ jsonrpc: "2.0", id: frame.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof DownstreamError && err.code === DownstreamErrorCode.Persistence
          ? -32000
          : -32603;
      const errorFrame: JsonRpcResponseError = {
        jsonrpc: "2.0",
        id: frame.id,
        error: { code, message }
      };
      await this.transport.send(errorFrame).catch(() => undefined);
    }
  }

  private handleTransportClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError =
      error ??
      new DownstreamError(DownstreamErrorCode.TransportClosed, "transport closed");

    // Reject every in-flight request so callers don't hang. Snapshot first
    // because reject handlers may run synchronously and mutate the map.
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(this.closeError);
    }
    // Fan out to subscribers (e.g. the session manager via bootstrap) so
    // they can mark bound runs failed. We snapshot to be safe against
    // listeners mutating the set during iteration.
    const listeners = Array.from(this.closeListeners);
    this.closeListeners.clear();
    for (const listener of listeners) {
      try {
        listener(this.closeError);
      } catch {
        // A misbehaving listener must not block other listeners or
        // cascade into the adapter's close path; swallow.
      }
    }
  }
}
