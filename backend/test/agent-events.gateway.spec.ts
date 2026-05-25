import { describe, expect, it, vi } from "vitest";
import { AgentEventsGateway, toFrontendAgentEvent } from "../src/realtime/agent-events.gateway";

describe("AgentEventsGateway", () => {
  it("maps text_delta to frontend-safe public_text messages", () => {
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
        type: "public_text",
        runId: "run-001"
      })
    );
  });

  it("does not expose Claude tool or thinking events to the frontend", () => {
    expect(toFrontendAgentEvent({
      eventId: "event-002",
      type: "tool_use",
      runId: "run-001",
      conversationId: "session-current",
      agentId: "claude",
      payload: { toolName: "Bash" },
      seq: 2,
      ts: 2
    })).toBeNull();

    expect(toFrontendAgentEvent({
      eventId: "event-003",
      type: "agent_thinking",
      runId: "run-001",
      conversationId: "session-current",
      agentId: "claude",
      payload: { thinking: "internal" },
      seq: 3,
      ts: 3
    })).toBeNull();
  });
});
