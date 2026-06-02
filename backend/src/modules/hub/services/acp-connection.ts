import { EventEmitter } from "node:events";

type Pending = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type AcpEnvelope = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number | string; message?: string } | string;
  // legacy fields preserved for downstream notification handlers
  type?: string;
  runId?: string;
  seq?: number;
  payload?: Record<string, unknown>;
  speaker?: string;
};

type NotificationHandler = (envelope: AcpEnvelope) => void;

/**
 * ACP JSON-RPC 连接封装，管理请求 ID、超时和响应匹配。
 * 不关心 ACP 会话语义（initialize/new/prompt），只提供 request/respond/notify 原语。
 */
export class AcpConnection extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private closing = false;

  /**
   * @param socket Socket.IO socket（需要已连接）
   * @param defaultTimeoutMs request() 默认超时毫秒数
   */
  constructor(
    readonly socket: { emit: (event: string, ...args: any[]) => any; on: (event: string, handler: (...args: any[]) => void) => any; disconnect: () => void; connected: boolean },
    private readonly defaultTimeoutMs = 3000,
  ) {
    super();
    this.setupListener();
  }

  // ---- RPC 原语 ----

  /** 发送 JSON-RPC 请求，返回 Promise<result> */
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method.toUpperCase()}_TIMEOUT`));
      }, timeoutMs ?? this.defaultTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.emit("acp:message", { jsonrpc: "2.0", id, method, params });
    });
  }

  /** 响应下游发来的请求（ack） */
  respond(id: string | number, result: Record<string, unknown> = { ok: true }) {
    this.socket.emit("acp:message", { jsonrpc: "2.0", id, result });
  }

  /** 响应下游发来的请求（error） */
  respondError(id: string | number, code: string, message: string) {
    this.socket.emit("acp:message", { jsonrpc: "2.0", id, error: { code, message } });
  }

  /** 发送通知（无 id，不需要响应） */
  notify(method: string, params: Record<string, unknown>) {
    this.socket.emit("acp:message", { jsonrpc: "2.0", method, params });
  }

  // ---- 通知处理 ----

  /** 注册下游通知处理器 */
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.add(handler);
    return () => { this.notificationHandlers.delete(handler); };
  }

  /** 关闭连接 */
  close() {
    this.closing = true;
    this.socket.disconnect();
    this.rejectAll(new Error("CONNECTION_CLOSED"));
  }

  // ---- internal ----

  private setupListener() {
    this.socket.on("acp:message", (msg: any) => {
      const envelope: AcpEnvelope = typeof msg === "string" ? JSON.parse(msg) : msg;
      this.handleEnvelope(envelope);
    });
  }

  private handleEnvelope(envelope: AcpEnvelope) {
    // 1. JSON-RPC response matching
    const requestId = normalizeRequestId(envelope.id);
    if (requestId !== null && this.pending.has(requestId)) {
      const pending = this.pending.get(requestId)!;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      if (envelope.error) {
        const message =
          typeof envelope.error === "string" ? envelope.error : envelope.error.message ?? "DOWNSTREAM_REQUEST_FAILED";
        pending.reject(new Error(message));
      } else {
        pending.resolve((envelope.result ?? {}) as Record<string, unknown>);
      }
      return;
    }

    // 2. Forward to notification handlers (session/update, session/event, legacy events, etc.)
    for (const handler of this.notificationHandlers) {
      handler(envelope);
    }
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.notificationHandlers.clear();
  }
}

function normalizeRequestId(id: string | number | undefined): number | null {
  if (typeof id === "number") return id;
  if (typeof id === "string" && /^\d+$/.test(id)) return Number(id);
  return null;
}
