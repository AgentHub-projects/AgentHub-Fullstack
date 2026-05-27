import type { JsonRpcFrame } from "./types";
import { DownstreamError, DownstreamErrorCode } from "./types";
import type { Transport } from "./transport";

/**
 * Bidirectional in-memory transport pair. Useful for tests and for the mock
 * orchestrator that runs in the same process as the AgentHub backend.
 *
 * Frames written to one end are delivered to the other on the next
 * microtask, which forces tests to exercise the same async ordering as a
 * real Socket.IO transport.
 */
export class InMemoryTransport implements Transport {
  private peer?: InMemoryTransport;
  private frameListener?: (frame: JsonRpcFrame) => void;
  private closeListener?: (error?: Error) => void;
  private open = true;

  static pair(): { a: InMemoryTransport; b: InMemoryTransport } {
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    a.peer = b;
    b.peer = a;
    return { a, b };
  }

  get isOpen(): boolean {
    return this.open;
  }

  async send(frame: JsonRpcFrame): Promise<void> {
    if (!this.open || !this.peer) {
      throw new DownstreamError(
        DownstreamErrorCode.TransportClosed,
        "transport is closed"
      );
    }
    const peer = this.peer;
    // Deliver on a microtask so producers can't observe synchronous responses
    // that would mask request/response ordering bugs.
    await Promise.resolve();
    if (peer.open) {
      peer.frameListener?.(frame);
    }
  }

  onFrame(listener: (frame: JsonRpcFrame) => void): void {
    this.frameListener = listener;
  }

  onClose(listener: (error?: Error) => void): void {
    this.closeListener = listener;
  }

  async close(error?: Error): Promise<void> {
    if (!this.open) return;
    this.open = false;
    this.closeListener?.(error);
    const peer = this.peer;
    if (peer && peer.open) {
      // Closing one end closes the peer with the same cause so neither side
      // is left dangling.
      await peer.close(error);
    }
  }
}
