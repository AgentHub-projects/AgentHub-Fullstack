import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import type {
  CreatePendingHubMessageRequest,
  PendingHubMessageDto,
  SendHubMessageRequest,
  UpdatePendingHubMessageRequest,
} from "@agenthub/shared";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";

type PendingStreamAction = "upsert" | "delete" | "drain";

type PendingStreamEntry = {
  streamId: string;
  action: PendingStreamAction;
  id: string;
  sessionId: string;
  payload?: SendHubMessageRequest;
  status?: PendingHubMessageDto["status"];
  errorMessage?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

@Injectable()
export class PendingMessageQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(PendingMessageQueueService.name);
  private readonly redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  constructor(@Inject(HubRealtimeGateway) private readonly gateway: HubRealtimeGateway) {
    this.redis.on("error", () => undefined);
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  async list(sessionId: string): Promise<PendingHubMessageDto[]> {
    return this.readCurrentQueue(sessionId);
  }

  async create(sessionId: string, input: CreatePendingHubMessageRequest): Promise<PendingHubMessageDto> {
    const now = new Date().toISOString();
    const pending: PendingHubMessageDto = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      sessionId,
      payload: normalizePayload(input),
      status: "pending",
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.append(sessionId, {
      action: "upsert",
      id: pending.id,
      payload: pending.payload,
      status: pending.status,
      errorMessage: pending.errorMessage,
      createdAt: pending.createdAt,
      updatedAt: pending.updatedAt,
    });
    this.gateway.emitPendingMessage(pending);
    return pending;
  }

  async update(sessionId: string, pendingId: string, input: UpdatePendingHubMessageRequest): Promise<PendingHubMessageDto> {
    const current = await this.readCurrentQueue(sessionId);
    const existing = current.find((item) => item.id === pendingId);
    if (!existing) throw new BadRequestException("PENDING_MESSAGE_NOT_FOUND");
    const pending: PendingHubMessageDto = {
      ...existing,
      payload: normalizePayload(input),
      status: "pending",
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    };
    await this.append(sessionId, {
      action: "upsert",
      id: pending.id,
      payload: pending.payload,
      status: pending.status,
      errorMessage: pending.errorMessage,
      createdAt: pending.createdAt,
      updatedAt: pending.updatedAt,
    });
    this.gateway.emitPendingMessage(pending);
    return pending;
  }

  async delete(sessionId: string, pendingId: string) {
    await this.append(sessionId, {
      action: "delete",
      id: pendingId,
      updatedAt: new Date().toISOString(),
    });
    this.gateway.emitPendingMessageDeleted(sessionId, pendingId);
    return { ok: true };
  }

  async peek(sessionId: string): Promise<PendingHubMessageDto | null> {
    return (await this.readCurrentQueue(sessionId))[0] ?? null;
  }

  async markSending(sessionId: string, pendingId: string): Promise<PendingHubMessageDto> {
    return this.updateStatus(sessionId, pendingId, "sending", null);
  }

  async markFailed(sessionId: string, pendingId: string, errorMessage: string): Promise<PendingHubMessageDto> {
    return this.updateStatus(sessionId, pendingId, "failed", errorMessage);
  }

  async markDrained(sessionId: string, pendingId: string) {
    await this.append(sessionId, {
      action: "drain",
      id: pendingId,
      updatedAt: new Date().toISOString(),
    });
    this.gateway.emitPendingMessageDeleted(sessionId, pendingId);
  }

  private async updateStatus(
    sessionId: string,
    pendingId: string,
    status: PendingHubMessageDto["status"],
    errorMessage: string | null,
  ) {
    const current = await this.readCurrentQueue(sessionId);
    const existing = current.find((item) => item.id === pendingId);
    if (!existing) throw new BadRequestException("PENDING_MESSAGE_NOT_FOUND");
    const pending: PendingHubMessageDto = {
      ...existing,
      status,
      errorMessage,
      updatedAt: new Date().toISOString(),
    };
    await this.append(sessionId, {
      action: "upsert",
      id: pending.id,
      payload: pending.payload,
      status: pending.status,
      errorMessage: pending.errorMessage,
      createdAt: pending.createdAt,
      updatedAt: pending.updatedAt,
    });
    this.gateway.emitPendingMessage(pending);
    return pending;
  }

  private async append(
    sessionId: string,
    input: {
      action: PendingStreamAction;
      id: string;
      payload?: SendHubMessageRequest;
      status?: PendingHubMessageDto["status"];
      errorMessage?: string | null;
      createdAt?: string;
      updatedAt?: string;
    },
  ) {
    try {
      await this.redis.xadd(
        streamKey(sessionId),
        "*",
        "action",
        input.action,
        "id",
        input.id,
        "sessionId",
        sessionId,
        "payload",
        input.payload ? JSON.stringify(input.payload) : "",
        "status",
        input.status ?? "",
        "errorMessage",
        input.errorMessage ?? "",
        "createdAt",
        input.createdAt ?? "",
        "updatedAt",
        input.updatedAt ?? "",
      );
    } catch (error) {
      this.logger.warn(`pending message queue append failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new BadRequestException("PENDING_QUEUE_UNAVAILABLE");
    }
  }

  private async readCurrentQueue(sessionId: string): Promise<PendingHubMessageDto[]> {
    let rows: Array<[string, string[]]>;
    try {
      rows = await this.redis.xrange(streamKey(sessionId), "-", "+");
    } catch (error) {
      this.logger.warn(`pending message queue read failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new BadRequestException("PENDING_QUEUE_UNAVAILABLE");
    }

    const order: string[] = [];
    const byId = new Map<string, PendingHubMessageDto>();
    for (const row of rows) {
      const entry = parseStreamEntry(sessionId, row);
      if (!entry?.id) continue;
      if (entry.action === "delete" || entry.action === "drain") {
        byId.delete(entry.id);
        continue;
      }
      if (!entry.payload) continue;
      const createdAt = entry.createdAt || entry.updatedAt || new Date(Number(entry.streamId.split("-")[0]) || Date.now()).toISOString();
      const pending: PendingHubMessageDto = {
        id: entry.id,
        sessionId,
        payload: entry.payload,
        status: entry.status ?? "pending",
        errorMessage: entry.errorMessage ?? null,
        createdAt,
        updatedAt: entry.updatedAt || createdAt,
      };
      if (!byId.has(entry.id)) order.push(entry.id);
      byId.set(entry.id, pending);
    }
    return order.map((id) => byId.get(id)).filter((item): item is PendingHubMessageDto => Boolean(item));
  }
}

function streamKey(sessionId: string) {
  return `agenthub:session:${sessionId}:pending_messages`;
}

function parseStreamEntry(sessionId: string, row: [string, string[]]): PendingStreamEntry | null {
  const [streamId, fields] = row;
  const data: Record<string, string> = {};
  for (let index = 0; index < fields.length; index += 2) {
    data[fields[index]] = fields[index + 1] ?? "";
  }
  const action = data.action as PendingStreamAction;
  if (action !== "upsert" && action !== "delete" && action !== "drain") return null;
  const payload = data.payload ? safePayload(data.payload) : undefined;
  return {
    streamId,
    action,
    id: data.id,
    sessionId: data.sessionId || sessionId,
    payload,
    status: normalizeStatus(data.status),
    errorMessage: data.errorMessage || null,
    createdAt: data.createdAt || undefined,
    updatedAt: data.updatedAt || undefined,
  };
}

function normalizeStatus(value: string | undefined): PendingHubMessageDto["status"] | undefined {
  return value === "sending" || value === "failed" || value === "pending" ? value : undefined;
}

function safePayload(value: string): SendHubMessageRequest | undefined {
  try {
    return normalizePayload(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function normalizePayload(input: unknown): SendHubMessageRequest {
  const record = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) throw new BadRequestException("PENDING_MESSAGE_CONTENT_REQUIRED");
  return {
    content,
    mentionedAgentIds: numberArray(record.mentionedAgentIds),
    orchestratorAgentId: numberValue(record.orchestratorAgentId),
    parentMessageId: stringValue(record.parentMessageId),
    quotedMessageId: stringValue(record.quotedMessageId),
    references: referenceArray(record.references),
    attachments: attachmentArray(record.attachments),
  };
}

function numberArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  return items.length ? items : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function referenceArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      messageId: stringValue(item.messageId),
      partId: stringValue(item.partId),
      selectedText: selectedTextValue(item.selectedText),
      sourceLabel: sourceLabelValue(item.sourceLabel),
    }))
    .filter((item) => item.messageId || item.selectedText);
  return items.length ? items.slice(0, 5) : undefined;
}

function selectedTextValue(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n/g, "\n").trim();
  return text ? text.slice(0, 8000) : undefined;
}

function sourceLabelValue(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 80) : undefined;
}

function attachmentArray(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({ id: stringValue(item.id) ?? "" }))
    .filter((item) => item.id);
  return items.length ? items.slice(0, 5) : undefined;
}
