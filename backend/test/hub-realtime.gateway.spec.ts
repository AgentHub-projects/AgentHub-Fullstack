import { describe, expect, it, vi } from "vitest";
import { HubRealtimeGateway } from "../src/modules/hub/gateways/hub-realtime.gateway";

function client(id: string) {
  return {
    id,
    emit: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
  } as any;
}

describe("HubRealtimeGateway subscriptions", () => {
  it("tracks unique frontend subscribers per session", () => {
    const gateway = new HubRealtimeGateway();
    const first = client("client-1");
    const second = client("client-2");

    gateway.subscribe(first, { sessionId: "session-1" });
    gateway.subscribe(first, { sessionId: "session-1" });
    gateway.subscribe(second, { sessionId: "session-1" });

    expect(gateway.getSessionSubscriberCount("session-1")).toBe(2);
    expect(gateway.hasSessionSubscribers("session-1")).toBe(true);

    gateway.unsubscribe(first, { sessionId: "session-1" });
    expect(gateway.getSessionSubscriberCount("session-1")).toBe(1);

    gateway.handleDisconnect(second);
    expect(gateway.getSessionSubscriberCount("session-1")).toBe(0);
    expect(gateway.hasSessionSubscribers("session-1")).toBe(false);
  });

  it("emits subscription ack immediately and notifies internal listeners once per client subscription", () => {
    const gateway = new HubRealtimeGateway();
    const socket = client("client-1");
    const handler = vi.fn();
    gateway.onSessionSubscribed(handler);

    gateway.subscribe(socket, { sessionId: "session-1" });
    gateway.subscribe(socket, { sessionId: "session-1" });

    expect(socket.emit).toHaveBeenCalledWith("session.subscribed", { sessionId: "session-1" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("session-1");
  });

  it("counts legacy joinConversation subscriptions", () => {
    const gateway = new HubRealtimeGateway();
    const socket = client("legacy-client");

    gateway.joinConversation(socket, { conversationId: "session-legacy" });

    expect(gateway.hasSessionSubscribers("session-legacy")).toBe(true);

    gateway.handleDisconnect(socket);
    expect(gateway.hasSessionSubscribers("session-legacy")).toBe(false);
  });
});
