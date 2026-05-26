import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import type {
  FrontendRealtimeEnvelope,
  FrontendRealtimeSubscribe,
  HubArtifactDto,
  HubContextSnapshotDto,
  HubEventDto,
  HubFileChangeDto,
  HubSessionDto,
} from "@agenthub/shared";

@WebSocketGateway({
  cors: true,
  path: "/socket.io",
})
export class HubRealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket) {
    client.emit("realtime.ready", { ok: true });
  }

  handleDisconnect(_client: Socket) {
    return;
  }

  @SubscribeMessage("session.subscribe")
  subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: FrontendRealtimeSubscribe) {
    if (body?.sessionId) {
      client.join(sessionRoom(body.sessionId));
      client.emit("session.subscribed", { sessionId: body.sessionId });
    }
  }

  @SubscribeMessage("session.unsubscribe")
  unsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: FrontendRealtimeSubscribe) {
    if (body?.sessionId) {
      client.leave(sessionRoom(body.sessionId));
    }
  }

  // 兼容旧前端事件名，迁移完后可以移除。
  @SubscribeMessage("joinConversation")
  joinConversation(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId?: string }) {
    if (body?.conversationId) {
      client.join(sessionRoom(body.conversationId));
    }
  }

  emitEvent(event: HubEventDto) {
    const envelope: FrontendRealtimeEnvelope = {
      type: "event",
      sessionId: event.sessionId,
      payload: event,
    };
    this.server.to(sessionRoom(event.sessionId)).emit("hub:event", envelope);
    this.server.to(sessionRoom(event.sessionId)).emit("run.event", event);
  }

  emitSession(session: HubSessionDto) {
    const envelope: FrontendRealtimeEnvelope = {
      type: "session",
      sessionId: session.id,
      payload: session,
    };
    this.server.to(sessionRoom(session.id)).emit("hub:session", envelope);
  }

  emitArtifact(sessionId: string, artifact: HubArtifactDto) {
    const envelope: FrontendRealtimeEnvelope = {
      type: "artifact",
      sessionId,
      payload: artifact,
    };
    this.server.to(sessionRoom(sessionId)).emit("hub:artifact", envelope);
  }

  emitFileChange(sessionId: string, fileChange: HubFileChangeDto) {
    const envelope: FrontendRealtimeEnvelope = {
      type: "file_change",
      sessionId,
      payload: fileChange,
    };
    this.server.to(sessionRoom(sessionId)).emit("hub:file_change", envelope);
  }

  emitContext(sessionId: string, context: HubContextSnapshotDto) {
    const envelope: FrontendRealtimeEnvelope = {
      type: "context",
      sessionId,
      payload: context,
    };
    this.server.to(sessionRoom(sessionId)).emit("hub:context", envelope);
  }
}

function sessionRoom(sessionId: string) {
  return `session:${sessionId}`;
}
