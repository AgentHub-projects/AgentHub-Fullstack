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
  private readonly clientSessions = new Map<string, Set<string>>();
  private readonly sessionSubscriberCounts = new Map<string, number>();

  handleConnection(client: Socket) {
    client.emit("realtime.ready", { ok: true });
  }

  handleDisconnect(client: Socket) {
    const sessions = this.clientSessions.get(client.id);
    if (!sessions) return;
    for (const sessionId of sessions) {
      this.decrementSessionSubscriber(sessionId);
    }
    this.clientSessions.delete(client.id);
  }

  @SubscribeMessage("session.subscribe")
  subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: FrontendRealtimeSubscribe) {
    if (body?.sessionId) {
      this.trackSubscription(client, body.sessionId);
      client.join(sessionRoom(body.sessionId));
      client.emit("session.subscribed", { sessionId: body.sessionId });
    }
  }

  @SubscribeMessage("session.unsubscribe")
  unsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: FrontendRealtimeSubscribe) {
    if (body?.sessionId) {
      this.untrackSubscription(client, body.sessionId);
      client.leave(sessionRoom(body.sessionId));
    }
  }

  // 兼容旧前端事件名，迁移完后可以移除。
  @SubscribeMessage("joinConversation")
  joinConversation(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId?: string }) {
    if (body?.conversationId) {
      this.trackSubscription(client, body.conversationId);
      client.join(sessionRoom(body.conversationId));
    }
  }

  hasSessionSubscribers(sessionId: string) {
    return this.getSessionSubscriberCount(sessionId) > 0;
  }

  getSessionSubscriberCount(sessionId: string) {
    return this.sessionSubscriberCounts.get(sessionId) ?? 0;
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

  private trackSubscription(client: Socket, sessionId: string) {
    let sessions = this.clientSessions.get(client.id);
    if (!sessions) {
      sessions = new Set<string>();
      this.clientSessions.set(client.id, sessions);
    }
    if (sessions.has(sessionId)) return;
    sessions.add(sessionId);
    this.sessionSubscriberCounts.set(sessionId, this.getSessionSubscriberCount(sessionId) + 1);
  }

  private untrackSubscription(client: Socket, sessionId: string) {
    const sessions = this.clientSessions.get(client.id);
    if (!sessions?.delete(sessionId)) return;
    if (sessions.size === 0) this.clientSessions.delete(client.id);
    this.decrementSessionSubscriber(sessionId);
  }

  private decrementSessionSubscriber(sessionId: string) {
    const next = this.getSessionSubscriberCount(sessionId) - 1;
    if (next > 0) {
      this.sessionSubscriberCounts.set(sessionId, next);
    } else {
      this.sessionSubscriberCounts.delete(sessionId);
    }
  }
}

function sessionRoom(sessionId: string) {
  return `session:${sessionId}`;
}
