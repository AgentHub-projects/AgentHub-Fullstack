import type { INestApplication } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import {
  DownstreamSessionManager,
  InMemoryTransport,
  MockOrchestrator,
  NorthAdapter
} from "../downstream";

/**
 * Wires the production-side downstream connection: a single NorthAdapter
 * is attached to the DownstreamSessionManager, and its transport's close
 * event is forwarded to {@link DownstreamSessionManager.handleConnectionLost}
 * so a dropped connection cannot leave bound runs in `running` state.
 *
 * For now the orchestrator end of the JSON-RPC link is the in-process
 * MockOrchestrator (real downstream worker scheduling is tracked by a
 * follow-up issue). Replacing it with a real Socket.IO client is a one
 * line change here — the close-wiring contract is what matters for the
 * AGE-5 acceptance criteria.
 */
const log = new Logger("DownstreamBootstrap");

export interface DownstreamRuntime {
  adapter: NorthAdapter;
  orchestrator: MockOrchestrator;
}

export function bootstrapDownstream(app: INestApplication): DownstreamRuntime {
  const manager = app.get(DownstreamSessionManager);
  const { a, b } = InMemoryTransport.pair();
  const adapter = new NorthAdapter(a);
  const orchestrator = new MockOrchestrator(b);

  // Wire the close event before attachAdapter so a transport that closes
  // racey-on-startup still routes through the manager. The adapter
  // multiplexes multiple subscribers, so this hook can coexist with the
  // adapter's own internal pending-request rejection path.
  adapter.onClose((error) => {
    const cause = error ?? new Error("downstream transport closed");
    log.error(`downstream transport closed: ${cause.message}`);
    void manager.handleConnectionLost(cause);
  });

  manager.attachAdapter(adapter);
  return { adapter, orchestrator };
}
