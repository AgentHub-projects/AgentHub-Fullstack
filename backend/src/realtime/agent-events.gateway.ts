import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { AgentEvent, AgentSubscribeRequest } from "@agenthub/shared";
import type { Server, Socket } from "socket.io";

const HIDDEN_FRONTEND_EVENT_TYPES = new Set<AgentEvent["type"]>([
  "agent_started",
  "agent_thinking",
  "tool_use",
  "tool_result",
  "team_planning",
  "team_plan_ready",
  "worker_assigned",
  "worker_result",
  "team_verifying",
  "team_verdict_ready",
  "team_completed",
  "team_failed",
]);

function textFromPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const text = (payload as { text?: unknown; output?: unknown; result?: unknown }).text
      ?? (payload as { text?: unknown; output?: unknown; result?: unknown }).output
      ?? (payload as { text?: unknown; output?: unknown; result?: unknown }).result;
    if (typeof text === "string") return text;
  }
  return "";
}

export function toFrontendAgentEvent(event: AgentEvent): AgentEvent | null {
  if (HIDDEN_FRONTEND_EVENT_TYPES.has(event.type)) {
    return null;
  }

  if (event.type === "text_delta") {
    const text = textFromPayload(event.payload);
    if (!text.trim()) {
      return null;
    }
    return {
      ...event,
      type: "public_text",
      payload: { text },
    };
  }

  return event;
}

@WebSocketGateway({ cors: true })
export class AgentEventsGateway {
  @WebSocketServer()
  private server?: Server;

  emitAgentEvent(event: AgentEvent): void {
    const frontendEvent = toFrontendAgentEvent(event);
    if (!frontendEvent) {
      return;
    }

    // Emit to conversation-scoped room
    this.server?.to(`conv:${frontendEvent.conversationId}`).emit("agent:event", frontendEvent);

    // Emit to per-agent room: agent:{agentId}:{runId}
    if (frontendEvent.runId && frontendEvent.agentId) {
      this.server
        ?.to(`agent:${frontendEvent.agentId}:${frontendEvent.runId}`)
        .emit(`agent:${frontendEvent.agentId}:${frontendEvent.runId}:event`, frontendEvent);
    }

    // Also emit globally for backward compatibility
    this.server?.emit?.("AgentEvent", frontendEvent);
    this.server?.emit?.("session:event", frontendEvent);
  }

  @SubscribeMessage("joinConversation")
  joinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId?: string },
  ) {
    if (body.conversationId) {
      client.join(`conv:${body.conversationId}`);
    }
    return { ok: true };
  }

  @SubscribeMessage("subscribeAgent")
  subscribeAgent(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: AgentSubscribeRequest,
  ) {
    const { agentId, runId, conversationId } = body;
    // Join per-agent room
    client.join(`agent:${agentId}:${runId}`);
    // Also ensure conversation room membership
    client.join(`conv:${conversationId}`);
    return { ok: true, channel: `agent:${agentId}:${runId}` };
  }

  @SubscribeMessage("unsubscribeAgent")
  unsubscribeAgent(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: AgentSubscribeRequest,
  ) {
    const { agentId, runId, conversationId } = body;
    client.leave(`agent:${agentId}:${runId}`);
    return { ok: true };
  }
}
