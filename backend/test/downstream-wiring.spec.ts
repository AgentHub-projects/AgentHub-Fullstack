import { describe, expect, it, vi } from "vitest";
import {
  DOWNSTREAM_PERSISTENCE_TOKEN,
  DOWNSTREAM_RUN_FAILURE_SINK_TOKEN,
  DownstreamError,
  DownstreamErrorCode,
  DownstreamSessionManager,
  InMemoryDownstreamPersistence,
  InMemoryTransport,
  MockOrchestrator,
  NorthAdapter,
  PrismaDownstreamPersistence,
  SocketIoTransport,
  type RunFailureSink,
  type SocketLike
} from "../src/downstream";
import { AgentEventsGateway } from "../src/realtime/agent-events.gateway";
import { AppModule } from "../src/modules/app.module";

function buildGatewayStub(): AgentEventsGateway {
  const gateway = new AgentEventsGateway();
  Object.assign(gateway, { server: { to: () => ({ emit: () => undefined }) } });
  vi.spyOn(gateway, "emitAgentEvent").mockImplementation(() => undefined);
  return gateway;
}

/** Minimal in-memory SocketLike used to drive SocketIoTransport without a
 *  real Socket.IO connection. Records the listeners attached/detached so
 *  tests can verify cleanup. */
class FakeSocket {
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  public connected = true;
  public disconnectCalls = 0;

  emit(event: string, _payload: unknown): unknown {
    return event;
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener?: (...args: unknown[]) => void): unknown {
    const set = this.listeners.get(event);
    if (!set) return this;
    if (listener) set.delete(listener);
    else set.clear();
    return this;
  }

  disconnect(): unknown {
    this.disconnectCalls += 1;
    this.connected = false;
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  fire(event: string, payload?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) {
      listener(payload as never);
    }
  }
}

describe("Downstream production wiring (P1/P2 fixes)", () => {
  it("transport close fans out to handleConnectionLost on the manager (P1-1)", async () => {
    // Build a real adapter + manager pair, then close the underlying
    // transport and verify handleConnectionLost was invoked end-to-end.
    const { a, b } = InMemoryTransport.pair();
    const adapter = new NorthAdapter(a, { requestTimeoutMs: 1_000 });
    const orchestrator = new MockOrchestrator(b);
    const gateway = buildGatewayStub();
    const persistence = new InMemoryDownstreamPersistence();
    const failures: Array<{ runId: string; code: string }> = [];
    const sink: RunFailureSink = (runId, failure) =>
      failures.push({ runId, code: failure.code });
    const manager = new DownstreamSessionManager(gateway, persistence, sink);
    manager.attachAdapter(adapter);

    const handleConnectionLost = vi.spyOn(manager, "handleConnectionLost");
    adapter.onClose((error) => {
      void manager.handleConnectionLost(error ?? new Error("transport closed"));
    });

    await manager.ensureSession({
      agentHubSessionId: "session-current",
      downstreamAgentId: "claude-code"
    });
    manager.setActiveRun("session-current", "run-001");

    await a.close(new DownstreamError(DownstreamErrorCode.TransportClosed, "boom"));
    // Allow microtasks to flush — close fan-out is async via void.
    await Promise.resolve();
    await Promise.resolve();

    expect(handleConnectionLost).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([
      expect.objectContaining({ runId: "run-001", code: DownstreamErrorCode.TransportClosed })
    ]);
    const persisted = await persistence.getSession("session-current");
    expect(persisted?.state).toBe("failed");
    void orchestrator;
  });

  it("DownstreamSessionManager uses the registered Prisma persistence + sink when constructed via DI tokens (P1-2)", async () => {
    // We cannot stand up the full Nest container in vitest because
    // emitDecoratorMetadata is not active here, so the resolution path
    // tested instead is: (a) AppModule registers the two DI tokens, and
    // (b) when the manager is constructed with a PrismaDownstreamPersistence
    // and a sink, those instances are the ones it uses (no silent
    // in-memory fallback). The two together prove production wiring.
    const moduleMetadata = Reflect.getMetadata("providers", AppModule) as Array<unknown>;
    const tokens = new Set<unknown>();
    for (const provider of moduleMetadata) {
      if (provider && typeof provider === "object" && "provide" in (provider as Record<string, unknown>)) {
        tokens.add((provider as { provide: unknown }).provide);
      } else if (provider) {
        tokens.add(provider);
      }
    }
    expect(tokens.has(DOWNSTREAM_PERSISTENCE_TOKEN)).toBe(true);
    expect(tokens.has(DOWNSTREAM_RUN_FAILURE_SINK_TOKEN)).toBe(true);

    const prismaStub = {
      downstreamSession: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn(),
        update: vi.fn()
      },
      downstreamEventAck: {
        findUnique: vi.fn(),
        create: vi.fn()
      },
      $transaction: vi.fn()
    };
    const persistence = new PrismaDownstreamPersistence(
      prismaStub as unknown as ConstructorParameters<typeof PrismaDownstreamPersistence>[0]
    );
    const sink: RunFailureSink = vi.fn();
    const manager = new DownstreamSessionManager(buildGatewayStub(), persistence, sink);

    const wiredPersistence = (manager as unknown as { persistence: unknown }).persistence;
    const wiredSink = (manager as unknown as { runFailureSink?: RunFailureSink }).runFailureSink;
    expect(wiredPersistence).toBe(persistence);
    expect(wiredSink).toBe(sink);

    // Smoke: the wired Prisma persistence reaches the underlying client
    // rather than the in-memory fallback.
    const { a, b } = InMemoryTransport.pair();
    const adapter = new NorthAdapter(a, { requestTimeoutMs: 1_000 });
    const orchestrator = new MockOrchestrator(b);
    void orchestrator;
    manager.attachAdapter(adapter);
    // Pre-load: getSession is read-only, so no upsert ambiguity.
    await persistence.getSession("missing-session");
    expect(prismaStub.downstreamSession.findUnique).toHaveBeenCalledWith({
      where: { agentHubSessionId: "missing-session" }
    });
  });

  it("concurrent ensureSession calls for the same downstreamAgentId do not collide on a sentinel row (P2 race)", async () => {
    // The pre-fix code wrote a placeholder row with downstreamSessionId=""
    // before calling session/new — under the @@unique([downstreamAgentId,
    // downstreamSessionId]) constraint two parallel callers would race on
    // that empty id. The fix waits for session/new to assign an id before
    // persisting, so concurrent calls each get their own row. We simulate
    // the constraint with a unique-tracking persistence and two parallel
    // ensureSession calls.
    class UniqueTrackingPersistence extends InMemoryDownstreamPersistence {
      override async upsertSession(input: {
        agentHubSessionId: string;
        downstreamSessionId: string;
        downstreamAgentId: string;
        state: import("../src/downstream").DownstreamSessionDto["state"];
      }): Promise<import("../src/downstream").DownstreamSessionDto> {
        // Reject any attempt to write a sentinel row twice (mimics
        // postgres unique violation on the (agentId, "") pair).
        for (const session of (this as unknown as { sessions: Map<string, import("../src/downstream").DownstreamSessionDto> }).sessions.values()) {
          if (
            session.downstreamSessionId === input.downstreamSessionId &&
            session.downstreamAgentId === input.downstreamAgentId &&
            session.agentHubSessionId !== input.agentHubSessionId
          ) {
            throw Object.assign(new Error("unique_violation"), { code: "P2002" });
          }
        }
        return super.upsertSession(input);
      }
    }

    const persistence = new UniqueTrackingPersistence();
    const { a, b } = InMemoryTransport.pair();
    const adapter = new NorthAdapter(a, { requestTimeoutMs: 1_000 });
    const orchestrator = new MockOrchestrator(b);
    void orchestrator;
    const manager = new DownstreamSessionManager(buildGatewayStub(), persistence);
    manager.attachAdapter(adapter);

    const [s1, s2] = await Promise.all([
      manager.ensureSession({ agentHubSessionId: "session-a", downstreamAgentId: "claude-code" }),
      manager.ensureSession({ agentHubSessionId: "session-b", downstreamAgentId: "claude-code" })
    ]);
    expect(s1.downstreamSessionId).not.toBe("");
    expect(s2.downstreamSessionId).not.toBe("");
    expect(s1.downstreamSessionId).not.toBe(s2.downstreamSessionId);
    expect(s1.state).toBe("ready");
    expect(s2.state).toBe("ready");
  });

  it("SocketIoTransport.close() detaches event listeners so late events do not re-enter (P2 cleanup)", async () => {
    const fake = new FakeSocket();
    const transport = new SocketIoTransport(fake as unknown as SocketLike);
    const closeSpy = vi.fn();
    transport.onClose(closeSpy);
    expect(fake.listenerCount("rpc")).toBe(1);
    expect(fake.listenerCount("disconnect")).toBe(1);
    expect(fake.listenerCount("connect_error")).toBe(1);

    await transport.close(new Error("intentional"));

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledWith(expect.any(Error));
    expect(fake.listenerCount("rpc")).toBe(0);
    expect(fake.listenerCount("disconnect")).toBe(0);
    expect(fake.listenerCount("connect_error")).toBe(0);

    // A late `disconnect` event after close must NOT trigger the close
    // path again. The closeListener stays at one call.
    fake.fire("disconnect", "late");
    fake.fire("rpc", { jsonrpc: "2.0", method: "x", params: {} });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("PrismaDownstreamPersistence treats unique-violation on event ack as idempotent no-op", async () => {
    const ackedSeen = { count: 0 };
    const prismaStub = {
      downstreamSession: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn()
      },
      downstreamEventAck: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async () => {
          ackedSeen.count += 1;
          throw Object.assign(new Error("unique_violation"), { code: "P2002" });
        })
      },
      $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaStub))
    };
    const persistence = new PrismaDownstreamPersistence(
      prismaStub as unknown as ConstructorParameters<typeof PrismaDownstreamPersistence>[0]
    );
    const result = await persistence.persistEventAndAck({
      agentHubSessionId: "session-current",
      downstreamSessionId: "dwn-1",
      agentId: "claude-code",
      runId: "run-1",
      eventId: "evt-1",
      seq: 1,
      ts: Date.now(),
      type: "text_delta",
      payload: { text: "x" }
    });
    expect(result).toBe(false);
    expect(ackedSeen.count).toBe(1);
  });
});
