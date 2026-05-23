import { MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import type { AgentEvent } from "@agenthub/shared";
import type { Server } from "socket.io";

@WebSocketGateway({ cors: true })
export class AgentEventsGateway {
  @WebSocketServer()
  private server?: Server;

  emitAgentEvent(event: AgentEvent): void {
    this.server?.to(`conv:${event.conversationId}`).emit("AgentEvent", event);
  }

  @SubscribeMessage("joinConversation")
  joinConversation(client: { join: (room: string) => void }, @MessageBody() body: { conversationId?: string }) {
    if (body.conversationId) {
      client.join(`conv:${body.conversationId}`);
    }
    return { ok: true };
  }
}
