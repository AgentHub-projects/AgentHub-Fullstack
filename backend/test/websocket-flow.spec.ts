import { describe, expect, it, vi } from "vitest";
import { AgentEventsGateway } from "../src/realtime/agent-events.gateway";

describe("WebSocket flow - AgentEventsGateway", () => {
  function createGateway() {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const gateway = new AgentEventsGateway();
    Object.assign(gateway, { server: { to } });
    return { gateway, emit, to };
  }

  it("routes events to the correct conversation room", () => {
    const { gateway, emit, to } = createGateway();

    gateway.emitAgentEvent({
      eventId: "evt-1",
      type: "text_delta",
      runId: "run-1",
      conversationId: "conv-abc",
      agentId: "agent-1",
      payload: { text: "hello" },
      seq: 1,
      ts: 1000,
    });

    expect(to).toHaveBeenCalledWith("conv:conv-abc");
    expect(emit).toHaveBeenCalledWith("agent:event", expect.objectContaining({ eventId: "evt-1", type: "text_delta" }));
  });

  it("sends all event types through the socket channel", () => {
    const { gateway, emit } = createGateway();

    const eventTypes = [
      "agent_started", "agent_thinking", "text_delta", "code_diff",
      "agent_completed", "agent_failed", "agent_cancelled", "done",
    ] as const;

    for (const type of eventTypes) {
      gateway.emitAgentEvent({
        eventId: `evt-${type}`,
        type,
        runId: "run-1",
        conversationId: "conv-1",
        agentId: "agent-1",
        payload: {},
        seq: 1,
        ts: Date.now(),
      });
    }

    expect(emit).toHaveBeenCalledTimes(eventTypes.length);
    for (const type of eventTypes) {
      expect(emit).toHaveBeenCalledWith("agent:event", expect.objectContaining({ type }));
    }
  });

  it("joinConversation subscribes client to the conversation room", () => {
    const join = vi.fn();
    const gateway = new AgentEventsGateway();

    const result = gateway.joinConversation({ join }, { conversationId: "conv-test" });
    expect(join).toHaveBeenCalledWith("conv:conv-test");
    expect(result).toEqual({ ok: true });
  });

  it("joinConversation skips joining when conversationId is missing", () => {
    const join = vi.fn();
    const gateway = new AgentEventsGateway();

    const result = gateway.joinConversation({ join }, {});
    expect(join).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("emits events to multiple conversation rooms independently", () => {
    const roomEmits: Record<string, ReturnType<typeof vi.fn>> = {};
    const to = vi.fn((room: string) => {
      if (!roomEmits[room]) roomEmits[room] = vi.fn();
      return { emit: roomEmits[room] };
    });

    const gateway = new AgentEventsGateway();
    Object.assign(gateway, { server: { to } });

    gateway.emitAgentEvent({
      eventId: "evt-a", type: "text_delta", runId: "run-a",
      conversationId: "conv-a", agentId: "agent-1",
      payload: { text: "A" }, seq: 1, ts: 1000,
    });

    gateway.emitAgentEvent({
      eventId: "evt-b", type: "text_delta", runId: "run-b",
      conversationId: "conv-b", agentId: "agent-2",
      payload: { text: "B" }, seq: 2, ts: 2000,
    });

    expect(to).toHaveBeenCalledWith("conv:conv-a");
    expect(to).toHaveBeenCalledWith("conv:conv-b");
    expect(roomEmits["conv:conv-a"]).toHaveBeenCalledWith("agent:event", expect.objectContaining({ eventId: "evt-a" }));
    expect(roomEmits["conv:conv-b"]).toHaveBeenCalledWith("agent:event", expect.objectContaining({ eventId: "evt-b" }));
  });
});
