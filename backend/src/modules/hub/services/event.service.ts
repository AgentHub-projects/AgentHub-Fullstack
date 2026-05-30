import { Inject, Injectable } from "@nestjs/common";
import type { HubEventDto, HubEventType } from "@agenthub/shared";
import { ArtifactStorageService } from "./artifact-storage.service";
import { HubContextService } from "./context.service";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { asObject, mapArtifact, mapEvent, mapFileChange, mapMessage } from "../mappers/hub.mappers";
import { PrismaService } from "./prisma.service";

// In-memory buffer for streaming messages (dual-track: real-time push + buffer for persistence)
type MessageBuffer = {
  messageId: string;
  contentText: string;
  speakerAgentId: number | null;
  speakerName: string;
  payload: Record<string, unknown>;
  startedAt: Date;
};

@Injectable()
export class HubEventService {
  private readonly messageBuffers = new Map<string, Map<string, MessageBuffer>>();
  // key: runId -> Map<speakerAgentId, MessageBuffer>

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(HubRealtimeGateway)
    private readonly gateway: HubRealtimeGateway,
    @Inject(ArtifactStorageService)
    private readonly artifacts: ArtifactStorageService,
    @Inject(HubContextService)
    private readonly context: HubContextService,
  ) {}

  async append(input: {
    sessionId: string;
    runId: string;
    eventType: HubEventType | string;
    payload?: Record<string, unknown>;
    speakerAgentId?: number | null;
    source?: string;
    visibility?: string;
    seq?: number;
    occurredAt?: Date;
  }): Promise<HubEventDto> {
    const speaker = input.speakerAgentId
      ? await this.prisma.agent.findUnique({ where: { id: input.speakerAgentId } })
      : null;
    const seq = BigInt(input.seq ?? (await this.nextSeq(input.runId)));

    let event;
    try {
      event = await this.prisma.agentEvent.create({
        data: {
          sessionId: input.sessionId,
          runId: input.runId,
          seq,
          source: input.source ?? "downstream_agent",
          eventType: input.eventType,
          visibility: input.visibility ?? "public",
          speakerAgentId: speaker?.id ?? null,
          speakerName: speaker?.name ?? null,
          payload: (input.payload ?? {}) as any,
          occurredAt: input.occurredAt ?? new Date(),
        },
      });
    } catch {
      const existing = await this.prisma.agentEvent.findFirst({
        where: { runId: input.runId, seq },
      });
      if (!existing) throw new Error("Failed to persist agent event");
      event = existing;
    }

    const dto = mapEvent(event);
    await this.applySideEffects(dto);
    this.gateway.emitEvent(dto);
    return dto;
  }

  private async nextSeq(runId: string): Promise<number> {
    const result = await this.prisma.agentEvent.aggregate({
      where: { runId },
      _max: { seq: true },
    });
    return Number(result._max.seq ?? 0n) + 1;
  }

  private async applySideEffects(event: HubEventDto) {
    const payload = event.payload;

    if (event.eventType === "message.delta") {
      const text = textFromPayload(payload);
      if (text.trim()) {
        this.upsertMessageBuffer(event, event.speakerAgentId ?? null, speakerBufferKey(event), text);
      }
    }

    if (event.eventType === "message.completed") {
      await this.persistCompletedMessage(event);
    }

    if (event.eventType === "file.change") {
      const change = await this.persistFileChange(event);
      if (change) {
        this.gateway.emitFileChange(event.sessionId, change);
        await this.context.recordContextItem({
          sessionId: event.sessionId,
          sourceType: "file_change",
          sourceId: change.id,
          kind: "file_change",
          text: `${change.changeType}: ${change.path}\n${change.patch ?? change.afterContent ?? ""}`.slice(0, 8000),
          importance: 40,
          metadata: { runId: event.runId },
        });
      }
    }

    if (event.eventType === "artifact.upsert") {
      const artifact = await this.artifacts.upsertArtifact({
        sessionId: event.sessionId,
        runId: event.runId,
        producingEventId: event.id,
        payload,
      });
      if (artifact) {
        this.gateway.emitArtifact(event.sessionId, artifact);
      }
    }

    if (event.eventType === "artifact.chunk") {
      const artifact = await this.artifacts.storeChunk({
        sessionId: event.sessionId,
        runId: event.runId,
        producingEventId: event.id,
        payload,
      });
      if (artifact) {
        this.gateway.emitArtifact(event.sessionId, artifact);
      }
    }

    if (event.eventType === "artifact.complete") {
      const artifact = await this.artifacts.completeArtifact({
        sessionId: event.sessionId,
        runId: event.runId,
        producingEventId: event.id,
        payload,
      });
      if (artifact) {
        this.gateway.emitArtifact(event.sessionId, artifact);
        await this.context.recordContextItem({
          sessionId: event.sessionId,
          sourceType: "artifact",
          sourceId: artifact.id,
          kind: "artifact",
          text: `${artifact.title}\n${artifact.textContent ?? artifact.storageUri ?? ""}`.slice(0, 8000),
          importance: 30,
          metadata: { runId: event.runId, kind: artifact.kind },
        });
      }
    }
  }

  // ---- Message Buffer Management (dual-track) ----

  private upsertMessageBuffer(event: HubEventDto, speakerAgentId: number | null, speakerKey: string, delta: string) {
    let runBuffers = this.messageBuffers.get(event.runId);
    if (!runBuffers) {
      runBuffers = new Map();
      this.messageBuffers.set(event.runId, runBuffers);
    }

    let buffer = runBuffers.get(speakerKey);
    if (!buffer) {
      buffer = {
        messageId: "", // Will be set on first persist
        contentText: "",
        speakerAgentId,
        speakerName: event.speakerName ?? speakerKey,
        payload: {},
        startedAt: new Date(),
      };
      runBuffers.set(speakerKey, buffer);
    }

    buffer.contentText += delta;
    buffer.payload = event.payload;
  }

  private async persistCompletedMessage(event: HubEventDto) {
    const text = textFromPayload(event.payload);
    const speakerAgentId = event.speakerAgentId ?? null;
    const speakerKey = speakerBufferKey(event);

    // Get buffered content or use event payload directly
    const runBuffers = this.messageBuffers.get(event.runId);
    const buffer = runBuffers?.get(speakerKey);
    const fullText = buffer?.contentText || text;

    if (!fullText.trim()) return;

    // Clean up buffer
    if (buffer) {
      runBuffers?.delete(speakerKey);
      if (runBuffers?.size === 0) this.messageBuffers.delete(event.runId);
    }

    const message = await this.prisma.message.create({
      data: {
        sessionId: event.sessionId,
        runId: event.runId,
        role: "assistant",
        agentId: speakerAgentId,
        contentText: fullText,
        contentJson: (event.payload ?? {}) as any,
        tokenCount: this.context.estimateTokens(fullText),
        status: "completed",
      },
    });

    await this.prisma.agentRun.update({
      where: { id: event.runId },
      data: { assistantMessageId: message.id },
    });

    await this.context.recordContextItem({
      sessionId: event.sessionId,
      sourceType: "message",
      sourceId: message.id,
      kind: "message",
      text: fullText,
      importance: 10,
      metadata: { runId: event.runId, agentId: speakerAgentId },
    });
  }

  private async persistFileChange(event: HubEventDto) {
    const payload = event.payload;
    const before = asObject(payload.before);
    const after = asObject(payload.after);
    const path = stringValue(payload.path) ?? stringValue(after.path) ?? stringValue(before.path);
    if (!path) return null;

    const created = await this.prisma.fileChange.create({
      data: {
        sessionId: event.sessionId,
        runId: event.runId,
        producingEventId: event.id,
        path,
        oldPath: stringValue(payload.oldPath),
        changeType: normalizeChangeType(stringValue(payload.changeType) ?? stringValue(payload.type) ?? "modified"),
        language: stringValue(payload.language),
        beforeContent: stringValue(before.content) ?? stringValue(payload.beforeContent),
        beforeSha256: stringValue(before.sha256) ?? stringValue(payload.beforeSha256),
        beforeTruncated: Boolean(before.truncated ?? payload.beforeTruncated ?? false),
        afterContent: stringValue(after.content) ?? stringValue(payload.afterContent),
        afterSha256: stringValue(after.sha256) ?? stringValue(payload.afterSha256),
        afterTruncated: Boolean(after.truncated ?? payload.afterTruncated ?? false),
        patch: stringValue(payload.patch),
        stats: asObject(payload.stats) as any,
        metadata: asObject(payload.metadata) as any,
      },
    });
    return mapFileChange(created);
  }

  async emitSnapshotArtifacts(sessionId: string) {
    const [artifacts, fileChanges] = await Promise.all([
      this.prisma.artifact.findMany({ where: { sessionId }, orderBy: { updatedAt: "desc" }, take: 20 }),
      this.prisma.fileChange.findMany({ where: { sessionId }, orderBy: { createdAt: "desc" }, take: 40 }),
    ]);
    for (const artifact of artifacts) {
      this.gateway.emitArtifact(sessionId, mapArtifact(artifact));
    }
    for (const change of fileChanges) {
      this.gateway.emitFileChange(sessionId, mapFileChange(change));
    }
  }
}

function textFromPayload(payload: Record<string, unknown>): string {
  const text = payload.text ?? payload.content ?? payload.message ?? payload.delta;
  return typeof text === "string" ? text : "";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function speakerBufferKey(event: HubEventDto): string {
  return String(event.speakerAgentId ?? event.speakerName ?? stringValue(event.payload.speaker) ?? "orchestrator");
}

function normalizeChangeType(value: string) {
  return value === "added" || value === "deleted" || value === "renamed" ? value : "modified";
}
