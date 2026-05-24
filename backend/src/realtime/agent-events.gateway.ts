import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { AgentEvent, AgentSubscribeRequest } from "@agenthub/shared";
import type { Server, Socket } from "socket.io";

@WebSocketGateway({ cors: true })
export class AgentEventsGateway {
  @WebSocketServer()
  private server?: Server;

  emitAgentEvent(event: AgentEvent): void {
    // Emit to conversation-scoped room
    this.server?.to(`conv:${event.conversationId}`).emit("agent:event", event);

    // Emit to per-agent room: agent:{agentId}:{runId}
    if (event.runId && event.agentId) {
      this.server
        ?.to(`agent:${event.agentId}:${event.runId}`)
        .emit(`agent:${event.agentId}:${event.runId}:event`, event);
    }

    // Also emit globally for backward compatibility
    this.server?.emit("AgentEvent", event);
    this.server?.emit("session:event", event);
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
