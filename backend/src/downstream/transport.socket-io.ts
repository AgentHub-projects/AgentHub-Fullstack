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

/**
 * Carries JSON-RPC frames over a Socket.IO connection. The downstream
 * orchestrator and AgentHub agree to use a single Socket.IO event name
 * (`rpc`) whose payload is one JSON-RPC frame.
 */
export class SocketIoTransport implements Transport {
  private frameListener?: (frame: JsonRpcFrame) => void;
  private closeListener?: (error?: Error) => void;
  private closed = false;

  constructor(private readonly socket: SocketLike) {
    socket.on(FRAME_EVENT, (payload) => {
      if (isJsonRpcRequest(payload) || isJsonRpcResponse(payload)) {
        this.frameListener?.(payload);
        return;
      }
      // Drop malformed frames — surface as a transport-close so the adapter
      // can fail any in-flight requests with a clear error.
      void this.close(
        new DownstreamError(DownstreamErrorCode.Protocol, "received malformed JSON-RPC frame")
      );
    });
    socket.on("disconnect", (reason) => {
      void this.close(
        new DownstreamError(DownstreamErrorCode.TransportClosed, `socket disconnected: ${reason ?? "unknown"}`)
      );
    });
    socket.on("connect_error", (err) => {
      void this.close(
        new DownstreamError(DownstreamErrorCode.TransportClosed, `socket connect_error: ${err.message}`, err)
      );
    });
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
    try {
      this.socket.disconnect();
    } catch {
      // Disconnecting an already-dead socket is fine.
    }
    this.closeListener?.(error);
  }
}
