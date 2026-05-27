import type { JsonRpcFrame } from "./types";
import { DownstreamError, DownstreamErrorCode, isJsonRpcRequest, isJsonRpcResponse } from "./types";
import type { Transport } from "./transport";

/**
 * Minimal Socket.IO client surface required by SocketIoTransport. We accept
 * any object that conforms to this shape (real `socket.io-client` Socket
 * instance, a server-side namespace socket, or a fake from tests) so the
 * transport stays free of an extra runtime dependency.
 */
export interface SocketLike {
  readonly connected: boolean;
  emit(event: string, payload: unknown): unknown;
  on(event: "connect", listener: () => void): unknown;
  on(event: "disconnect", listener: (reason?: string) => void): unknown;
  on(event: "connect_error", listener: (error: Error) => void): unknown;
  on(event: string, listener: (payload: unknown) => void): unknown;
  off?(event: string, listener?: (...args: unknown[]) => void): unknown;
  disconnect(): unknown;
}

const FRAME_EVENT = "rpc";
const DISCONNECT_EVENT = "disconnect";
const CONNECT_ERROR_EVENT = "connect_error";

/**
 * Carries JSON-RPC frames over a Socket.IO connection. The downstream
 * orchestrator and AgentHub agree to use a single Socket.IO event name
 * (`rpc`) whose payload is one JSON-RPC frame.
 */
export class SocketIoTransport implements Transport {
  private frameListener?: (frame: JsonRpcFrame) => void;
  private closeListener?: (error?: Error) => void;
  private closed = false;

  // Bound handlers retained so `close()` can detach them and stop late
  // events from firing the close path a second time after the transport
  // is intentionally torn down.
  private readonly onRpc: (payload: unknown) => void;
  private readonly onDisconnect: (reason?: string) => void;
  private readonly onConnectError: (err: Error) => void;

  constructor(private readonly socket: SocketLike) {
    this.onRpc = (payload: unknown) => {
      if (this.closed) return;
      if (isJsonRpcRequest(payload) || isJsonRpcResponse(payload)) {
        this.frameListener?.(payload);
        return;
      }
      // Drop malformed frames — surface as a transport-close so the adapter
      // can fail any in-flight requests with a clear error.
      void this.close(
        new DownstreamError(DownstreamErrorCode.Protocol, "received malformed JSON-RPC frame")
      );
    };
    this.onDisconnect = (reason?: string) => {
      if (this.closed) return;
      void this.close(
        new DownstreamError(DownstreamErrorCode.TransportClosed, `socket disconnected: ${reason ?? "unknown"}`)
      );
    };
    this.onConnectError = (err: Error) => {
      if (this.closed) return;
      void this.close(
        new DownstreamError(DownstreamErrorCode.TransportClosed, `socket connect_error: ${err.message}`, err)
      );
    };
    socket.on(FRAME_EVENT, this.onRpc);
    socket.on(DISCONNECT_EVENT, this.onDisconnect);
    socket.on(CONNECT_ERROR_EVENT, this.onConnectError);
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.connected;
  }

  async send(frame: JsonRpcFrame): Promise<void> {
    if (!this.isOpen) {
      throw new DownstreamError(
        DownstreamErrorCode.TransportClosed,
        "socket is not connected"
      );
    }
    this.socket.emit(FRAME_EVENT, frame);
  }

  onFrame(listener: (frame: JsonRpcFrame) => void): void {
    this.frameListener = listener;
  }

  onClose(listener: (error?: Error) => void): void {
    this.closeListener = listener;
  }

  async close(error?: Error): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Detach our listeners before disconnecting so any late `disconnect` /
    // `rpc` events the socket emits during teardown do not re-enter the
    // close path (which would override `error` with a generic message) or
    // leak through to a stale frameListener after teardown.
    try {
      this.socket.off?.(FRAME_EVENT, this.onRpc as (...args: unknown[]) => void);
      this.socket.off?.(DISCONNECT_EVENT, this.onDisconnect as (...args: unknown[]) => void);
      this.socket.off?.(CONNECT_ERROR_EVENT, this.onConnectError as (...args: unknown[]) => void);
    } catch {
      // `off` is optional on the SocketLike contract; if it throws on a
      // strict implementation, the disconnect below still tears the socket
      // down.
    }
    try {
      this.socket.disconnect();
    } catch {
      // Disconnecting an already-dead socket is fine.
    }
    this.closeListener?.(error);
  }
}
