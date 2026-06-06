import { Inject, Logger, Optional } from "@nestjs/common";
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
  HubMessageDto,
  HubSessionDto,
} from "@agenthub/shared";
import { AuthSessionService } from "../auth/auth-session.service";

type SessionSubscriptionHandler = (sessionId: string) => void | Promise<void>;

/** WebSocket 实时网关：管理客户端连接、会话订阅和实时事件推送 */
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  path: "/socket.io",
})
export class HubRealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;
  private readonly clientSessions = new Map<string, Set<string>>();
  private readonly sessionSubscriberCounts = new Map<string, number>();
  private readonly sessionSubscriptionHandlers = new Set<SessionSubscriptionHandler>();

  constructor(@Optional() @Inject(AuthSessionService) private readonly authSessions?: AuthSessionService) {}

  private readonly logger = new Logger(HubRealtimeGateway.name);

  /** 注册后端内部订阅监听；网关只发布订阅事实，不依赖具体下游服务 */
  onSessionSubscribed(handler: SessionSubscriptionHandler) {
    this.sessionSubscriptionHandlers.add(handler);
    return () => {
      this.sessionSubscriptionHandlers.delete(handler);
    };
  }

  /** 客户端连接时认证 Cookie，失败则发送 auth.required 并断开 */
  async handleConnection(client: Socket) {
    this.logger.log(`[Socket.IO] 新连接 clientId=${client.id} hasCookie=${!!client.handshake.headers.cookie}`);
    if (!this.authSessions || !(await this.authSessions.authenticateCookie(client.handshake.headers.cookie))) {
      this.logger.warn(`[Socket.IO] 认证失败 clientId=${client.id} hasAuthService=${!!this.authSessions}`);
      client.emit("auth.required", { message: "AUTH_REQUIRED" });
      client.disconnect(true);
      return;
    }
    this.logger.log(`[Socket.IO] 连接成功 clientId=${client.id}`);
    client.emit("realtime.ready", { ok: true });
  }

  /** 客户端断开时清理订阅追踪 */
  handleDisconnect(client: Socket) {
    const sessions = this.clientSessions.get(client.id);
    if (!sessions) return;
    for (const sessionId of sessions) {
      this.decrementSessionSubscriber(sessionId);
    }
    this.clientSessions.delete(client.id);
  }

  /** 客户端订阅会话房间 */
  @SubscribeMessage("session.subscribe")
  subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: FrontendRealtimeSubscribe) {
    this.logger.log(`[订阅] clientId=${client.id} sessionId=${body?.sessionId}`);
    if (body?.sessionId) {
      const tracked = this.trackSubscription(client, body.sessionId);
      client.join(sessionRoom(body.sessionId));
      client.emit("session.subscribed", { sessionId: body.sessionId });
      if (tracked) this.notifySessionSubscribed(body.sessionId);
    }
  }

  /** 客户端取消订阅会话房间 */
  @SubscribeMessage("session.unsubscribe")
  unsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: FrontendRealtimeSubscribe) {
    if (body?.sessionId) {
      this.untrackSubscription(client, body.sessionId);
      client.leave(sessionRoom(body.sessionId));
    }
  }

  /** 兼容旧前端 joinConversation 事件名 */
  // 兼容旧前端事件名，迁移完后可以移除。
  @SubscribeMessage("joinConversation")
  joinConversation(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId?: string }) {
    if (body?.conversationId) {
      const tracked = this.trackSubscription(client, body.conversationId);
      client.join(sessionRoom(body.conversationId));
      if (tracked) this.notifySessionSubscribed(body.conversationId);
    }
  }

  /** 检查会话是否有 WebSocket 订阅者 */
  hasSessionSubscribers(sessionId: string) {
    return this.getSessionSubscriberCount(sessionId) > 0;
  }

  /** 获取会话订阅人数 */
  getSessionSubscriberCount(sessionId: string) {
    return this.sessionSubscriberCounts.get(sessionId) ?? 0;
  }

  /** 推送事件到会话房间 */
  emitEvent(event: HubEventDto) {
    const room = sessionRoom(event.sessionId);
    const clients = this.server.sockets.adapter.rooms.get(room)?.size ?? 0;
    this.logger.log(`[发送] emitEvent type=${event.eventType} room=${room} clients=${clients}`);
    const envelope: FrontendRealtimeEnvelope = {
      type: "event",
      sessionId: event.sessionId,
      payload: event,
    };
    this.server.to(room).emit("hub:event", envelope);
    this.server.to(room).emit("run.event", event);
  }

  /** 推送会话更新 */
  emitSession(session: HubSessionDto) {
    const room = sessionRoom(session.id);
    const clients = this.server.sockets.adapter.rooms.get(room)?.size ?? 0;
    this.logger.log(`[发送] emitSession sessionId=${session.id} room=${room} clients=${clients}`);
    const envelope: FrontendRealtimeEnvelope = {
      type: "session",
      sessionId: session.id,
      payload: session,
    };
    this.server.to(room).emit("hub:session", envelope);
  }

  /** 推送消息到会话房间 */
  emitMessage(message: HubMessageDto) {
    const envelope: FrontendRealtimeEnvelope = {
      type: "message",
      sessionId: message.sessionId,
      payload: message,
    };
    this.server.to(sessionRoom(message.sessionId)).emit("hub:message", envelope);
  }

  /** 推送产物更新 */
  emitArtifact(sessionId: string, artifact: HubArtifactDto) {
    const envelope: FrontendRealtimeEnvelope = {
      type: "artifact",
      sessionId,
      payload: artifact,
    };
    this.server.to(sessionRoom(sessionId)).emit("hub:artifact", envelope);
  }

  /** 推送文件变更 */
  emitFileChange(sessionId: string, fileChange: HubFileChangeDto) {
    const envelope: FrontendRealtimeEnvelope = {
      type: "file_change",
      sessionId,
      payload: fileChange,
    };
    this.server.to(sessionRoom(sessionId)).emit("hub:file_change", envelope);
  }

  /** 推送上下文快照 */
  emitContext(sessionId: string, context: HubContextSnapshotDto) {
    const envelope: FrontendRealtimeEnvelope = {
      type: "context",
      sessionId,
      payload: context,
    };
    this.server.to(sessionRoom(sessionId)).emit("hub:context", envelope);
  }

  /** 追踪客户端订阅并更新计数 */
  private trackSubscription(client: Socket, sessionId: string) {
    let sessions = this.clientSessions.get(client.id);
    if (!sessions) {
      sessions = new Set<string>();
      this.clientSessions.set(client.id, sessions);
    }
    if (sessions.has(sessionId)) return false;
    sessions.add(sessionId);
    this.sessionSubscriberCounts.set(sessionId, this.getSessionSubscriberCount(sessionId) + 1);
    return true;
  }

  /** 清理客户端订阅追踪并递减计数 */
  private untrackSubscription(client: Socket, sessionId: string) {
    const sessions = this.clientSessions.get(client.id);
    if (!sessions?.delete(sessionId)) return;
    if (sessions.size === 0) this.clientSessions.delete(client.id);
    this.decrementSessionSubscriber(sessionId);
  }

  /** 递减会话订阅者计数 */
  private decrementSessionSubscriber(sessionId: string) {
    const next = this.getSessionSubscriberCount(sessionId) - 1;
    if (next > 0) {
      this.sessionSubscriberCounts.set(sessionId, next);
    } else {
      this.sessionSubscriberCounts.delete(sessionId);
    }
  }

  /** 异步通知内部监听器，不阻塞前端订阅 ACK */
  private notifySessionSubscribed(sessionId: string) {
    for (const handler of this.sessionSubscriptionHandlers) {
      try {
        void Promise.resolve(handler(sessionId)).catch((error) => {
          this.logger.warn(`[订阅] 内部监听失败 sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        this.logger.warn(`[订阅] 内部监听失败 sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** 生成 Socket.IO 房间名 */
function sessionRoom(sessionId: string) {
  return `session:${sessionId}`;
}
