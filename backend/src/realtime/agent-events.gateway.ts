import { MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Inject, Optional } from "@nestjs/common";
import type { AgentEvent } from "@agenthub/shared";
import type { Server } from "socket.io";
import { EventStore } from "../services/event-store.service";

@WebSocketGateway({ cors: true })
export class AgentEventsGateway {
  @WebSocketServer()
  private server?: Server;

  constructor(@Optional() @Inject(EventStore) private readonly eventStore?: EventStore) {}

  async emitAgentEvent(event: AgentEvent): Promise<void> {
    await this.eventStore?.ingest(event);
    this.server?.to(`conv:${event.conversationId}`).emit("agent:event", event);
  }

  @SubscribeMessage("joinConversation")
  joinConversation(client: { join: (room: string) => void }, @MessageBody() body: { conversationId?: string }) {
    if (body.conversationId) {
      client.join(`conv:${body.conversationId}`);
    }
    return { ok: true };
  }
}
