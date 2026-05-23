import { describe, expect, it, vi } from "vitest";
import { AgentEventsGateway } from "../src/realtime/agent-events.gateway";

describe("AgentEventsGateway", () => {
  it("emits frontend-compatible agent:event messages to conversation rooms", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const gateway = new AgentEventsGateway();
    Object.assign(gateway, { server: { to } });

    gateway.emitAgentEvent({
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
});
