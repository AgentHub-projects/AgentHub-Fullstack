import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agenthub/shared";
import { AgentEventsGateway } from "../src/realtime/agent-events.gateway";
import {
  DownstreamError,
  DownstreamErrorCode,
  DownstreamSessionManager,
  InMemoryDownstreamPersistence,
  InMemoryTransport,
  MockOrchestrator,
  NorthAdapter,
  type RunFailure
} from "../src/downstream";

function buildGateway() {
  const emit = vi.fn<(event: AgentEvent) => void>();
  const gateway = new AgentEventsGateway();
  Object.assign(gateway, { server: { to: () => ({ emit: () => undefined }) } });
  // Bypass the room dispatch to make assertions simple.
  vi.spyOn(gateway, "emitAgentEvent").mockImplementation((event) => emit(event));
  return { gateway, emit };
}

interface Wired {
  manager: DownstreamSessionManager;
  adapter: NorthAdapter;
  orchestrator: MockOrchestrator;
  persistence: InMemoryDownstreamPersistence;
  emitted: ReturnType<typeof buildGateway>["emit"];
  failures: Array<{ runId: string; failure: RunFailure }>;
}

function wireUp(): Wired {
  const { a, b } = InMemoryTransport.pair();
  const adapter = new NorthAdapter(a, { requestTimeoutMs: 1_000 });
  const orchestrator = new MockOrchestrator(b);
  const { gateway, emit } = buildGateway();
  const persistence = new InMemoryDownstreamPersistence();
  const failures: Array<{ runId: string; failure: RunFailure }> = [];
  const manager = new DownstreamSessionManager(gateway, persistence, (runId, failure) => {
    failures.push({ runId, failure });
  });
  manager.attachAdapter(adapter);
  return { manager, adapter, orchestrator, persistence, emitted: emit, failures };
}

describe("DownstreamSessionManager (integration with mock orchestrator)", () => {
  it("performs initialize handshake", async () => {
    const { manager } = wireUp();
    const result = await manager.initialize();
    expect(result.server.protocol).toBe("north");
  });

  it("creates a downstream session, persists the binding, and reuses it on reconnect", async () => {
    const w = wireUp();
    const session = await w.manager.ensureSession({
      agentHubSessionId: "session-current",
      downstreamAgentId: "claude-code",
      title: "Demo"
    });
    expect(session.downstreamSessionId).toMatch(/^dwn-/);
    expect(session.state).toBe("ready");

    const persisted = await w.persistence.getSession("session-current");
    expect(persisted?.downstreamSessionId).toBe(session.downstreamSessionId);

    // Reconnect with a brand-new adapter/orchestrator, but reuse the
    // persisted binding. This mirrors a process restart where the
    // orchestrator already knows about the session.
    const { a: a2, b: b2 } = InMemoryTransport.pair();
    const adapter2 = new NorthAdapter(a2);
    const orchestrator2 = new MockOrchestrator(b2);
    // Pre-register the session id on the new orchestrator so session/load succeeds.
    await orchestrator2["dispatch"]("session/new", {
      agentHubSessionId: "session-current",
      agentId: "claude-code"
    });
    // Replace the persisted downstream id so session/load points at the
    // new orchestrator's id.
    const newId = "dwn-1";
    await w.persistence.upsertSession({
      agentHubSessionId: "session-current",
      downstreamSessionId: newId,
      downstreamAgentId: "claude-code",
      state: "ready"
    });
    w.manager.attachAdapter(adapter2);
    const reused = await w.manager.ensureSession({
      agentHubSessionId: "session-current",
      downstreamAgentId: "claude-code"
    });
    expect(reused.downstreamSessionId).toBe(newId);
  });

  it("emits text deltas and completion only after persistence ack", async () => {
    const w = wireUp();
    await w.manager.ensureSession({
      agentHubSessionId: "session-current",
      downstreamAgentId: "claude-code"
    });
    await w.manager.sendPrompt({
      agentHubSessionId: "session-current",
      runId: "run-001",
      prompt: "hello world",
      mentions: [{ agentId: "claude-code", displayName: "Claude" }],
      context: [{ id: "ctx-1", kind: "text", body: "pinned" }]
    });

    // Drain microtasks until the orchestrator finishes the script.
    for (let i = 0; i < 50 && w.persistence.events.length < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(w.persistence.events.map((e) => e.type)).toEqual([
      "text_delta",
      "text_delta",
      "text_delta",
      "agent_completed",
      "done"
    ]);
    expect(w.emitted).toHaveBeenCalled();
    // Every persisted event must also be broadcast — the persist/ack pair
    // is what gates the broadcast.
    expect(w.emitted.mock.calls.length).toBe(w.persistence.events.length);
  });

  it("ignores duplicate downstream event ids (idempotent ack)", async () => {
    const w = wireUp();
    await w.manager.ensureSession({
      agentHubSessionId: "session-current",
      downstreamAgentId: "claude-code"
    });
    await w.manager.sendPrompt({
      agentHubSessionId: "session-current",
      runId: "run-002",
      prompt: "ping"
    });
    for (let i = 0; i < 50 && w.persistence.events.length < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }

    const persistedBefore = w.persistence.events.length;
    const broadcastBefore = w.emitted.mock.calls.length;
    const reused = await w.orchestrator.emitDuplicateEvent(
      "dwn-1",
      "run-002",
      w.persistence.events[0].eventId
    );
    expect(reused.acked).toBe(true);
    // Same eventId must NOT produce another persisted event or broadcast.
    expect(w.persistence.events.length).toBe(persistedBefore);
    expect(w.emitted.mock.calls.length).toBe(broadcastBefore);
  });

  it("ack is withheld when persistence throws, so the orchestrator can retry", async () => {
    const { a, b } = InMemoryTransport.pair();
    const adapter = new NorthAdapter(a, { requestTimeoutMs: 1_000 });
    const orchestrator = new MockOrchestrator(b, { silent: true });
    const { gateway, emit } = buildGateway();
    const persistence = new InMemoryDownstreamPersistence();
    let nextAttemptShouldFail = true;
    const original = persistence.persistEventAndAck.bind(persistence);
    persistence.persistEventAndAck = async (event) => {
      if (nextAttemptShouldFail) {
        nextAttemptShouldFail = false;
        throw new DownstreamError(DownstreamErrorCode.Persistence, "db down");
      }
      return original(event);
    };
    const manager = new DownstreamSessionManager(gateway, persistence);
    manager.attachAdapter(adapter);

    await manager.ensureSession({
      agentHubSessionId: "session-current",
      downstreamAgentId: "claude-code"
    });
    // Hand-craft an event the manager will try to persist.
    const session = (orchestrator as unknown as { sessions: Map<string, { downstreamSessionId: string; agentHubSessionId: string; agentId: string; cancelled: boolean }> }).sessions.get("dwn-1");
    expect(session).toBeDefined();
    const first = orchestrator
      .emitEvent(session!, "run-003", 1, "text_delta", { text: "x" }, "evt-fixed")
      .catch((e: unknown) => e);
    const failure = await first;
    expect(failure).toBeInstanceOf(DownstreamError);

    // Retry the same event id; persistence accepts it now.
    const retry = await orchestrator.emitEvent(session!, "run-003", 1, "text_delta", { text: "x" }, "evt-fixed");
    expect(retry.acked).toBe(true);
    expect(persistence.events).toHaveLength(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("marks the run failed when session/prompt fails on the orchestrator", async () => {
    const w = wireUp();
    await w.manager.ensureSession({
      agentHubSessionId: "session-current",
      downstreamAgentId: "claude-code"
    });
    // Force the orchestrator to reject prompts.
    const original = (w.orchestrator as unknown as { dispatch: (m: string, p: unknown) => Promise<unknown> }).dispatch.bind(w.orchestrator);
    (w.orchestrator as unknown as { dispatch: (m: string, p: unknown) => Promise<unknown> }).dispatch = async (m, p) => {
      if (m === "session/prompt") throw new Error("worker offline");
      return original(m, p);
    };

    const failure = await w.manager
      .sendPrompt({ agentHubSessionId: "session-current", runId: "run-004", prompt: "x" })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(w.failures).toEqual([
      expect.objectContaining({ runId: "run-004", failure: expect.objectContaining({ message: expect.stringContaining("worker offline") }) })
    ]);
  });

  it("connection loss marks bound runs failed and records lastError", async () => {
    const w = wireUp();
    await w.manager.ensureSession({
      agentHubSessionId: "session-current",
      downstreamAgentId: "claude-code"
    });
    w.manager.setActiveRun("session-current", "run-005");
    await w.manager.handleConnectionLost(new Error("socket closed"));
    expect(w.failures).toEqual([
      expect.objectContaining({ runId: "run-005", failure: expect.objectContaining({ code: DownstreamErrorCode.TransportClosed }) })
    ]);
    const persisted = await w.persistence.getSession("session-current");
    expect(persisted?.state).toBe("failed");
    expect(persisted?.lastError).toContain("socket closed");
  });
});
