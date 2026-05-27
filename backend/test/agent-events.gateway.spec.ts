import { describe, expect, it, vi } from "vitest";
import { AgentEventsGateway } from "../src/realtime/agent-events.gateway";

describe("AgentEventsGateway", () => {
  it("emits frontend-compatible agent:event messages to conversation rooms", async () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const gateway = new AgentEventsGateway();
    Object.assign(gateway, { server: { to } });

    await gateway.emitAgentEvent({
      eventId: "event-001",
      type: "text_delta",
      runId: "run-001",
      conversationId: "session-current",
      agentId: "claude",
      payload: { text: "hello" },
      seq: 1,
      ts: 1
    });

    expect(to).toHaveBeenCalledWith("conv:session-current");
    expect(emit).toHaveBeenCalledWith(
      "agent:event",
      expect.objectContaining({
        runId: "run-001"
      })
    );
  });

  it("awaits persistence and does not broadcast when ingest fails", async () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const eventStore = {
      ingest: vi.fn(async () => {
        throw new Error("db unavailable");
      })
    };
    const gateway = new AgentEventsGateway(eventStore as never);
    Object.assign(gateway, { server: { to } });

    await expect(
      gateway.emitAgentEvent({
        eventId: "event-002",
        type: "text_delta",
        runId: "run-002",
        conversationId: "session-current",
        agentId: "claude",
        payload: { text: "hello" },
        seq: 1,
        ts: 1
      })
    ).rejects.toThrow("db unavailable");

    expect(eventStore.ingest).toHaveBeenCalledOnce();
    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
