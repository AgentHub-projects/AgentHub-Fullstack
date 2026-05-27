import type { JsonRpcFrame } from "./types";

/**
 * Opaque message-oriented duplex transport. The adapter writes JSON-RPC
 * frames out via {@link send} and consumes incoming frames via the
 * `onFrame` listener.
 *
 * Implementations may wrap a Socket.IO client, a worker_thread MessagePort,
 * or an in-process pipe (used by the mock orchestrator in tests).
 */
export interface Transport {
  /** Send a single JSON-RPC frame. Resolves once the frame is enqueued. */
  send(frame: JsonRpcFrame): Promise<void>;
  /** Register the (single) frame listener. */
  onFrame(listener: (frame: JsonRpcFrame) => void): void;
  /** Register a one-shot close listener; receives an error if the transport closed abnormally. */
  onClose(listener: (error?: Error) => void): void;
  /** Close the transport. Pending operations should reject with TransportClosed. */
  close(error?: Error): Promise<void>;
  /** True when the transport is open and may send frames. */
  readonly isOpen: boolean;
}
