import { Inject, Injectable } from "@nestjs/common";
import type { HubArtifactDto, HubEventDto, HubEventType, HubMessagePartDto } from "@agenthub/shared";
import { ArtifactStorageService } from "./artifact-storage.service";
import { HubContextService } from "./context.service";
import { HubRealtimeGateway } from "../gateways/hub-realtime.gateway";
import { asObject, mapArtifact, mapEvent, mapFileChange, mapMessage } from "../mappers/hub.mappers";
import { PrismaService } from "./prisma.service";
import { messageJsonWithParts } from "../utils/message-parts";

// In-memory buffer for streaming messages (dual-track: real-time push + buffer for persistence)
type MessageBuffer = {
  messageId: string;
  contentText: string;
  speakerAgentId: number | null;
  speakerName: string;
  payload: Record<string, unknown>;
  startedAt: Date;
};
const RUN_ARTIFACT_PARTS_KEY = "__run_artifacts__";

@Injectable()
export class HubEventService {
  private readonly messageBuffers = new Map<string, Map<string, MessageBuffer>>();
  private readonly artifactPartBuffers = new Map<string, Map<string, HubMessagePartDto[]>>();
  private readonly runSeqWatermarks = new Map<string, number>();
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
    const run = await this.prisma.agentRun.findUnique({
      where: { id: input.runId },
      select: { status: true },
    });
    if (
      run?.status === "cancelled" &&
      input.source !== "agenthub_backend" &&
      input.eventType !== "run.cancelled"
    ) {
      throw new Error("RUN_ALREADY_CANCELLED");
    }

    const speaker = input.speakerAgentId
      ? await this.prisma.agent.findUnique({ where: { id: input.speakerAgentId } })
      : null;
    const expectedSeq = await this.nextSeq(input.runId);
    if (input.seq !== undefined) {
      const existing = await this.prisma.agentEvent.findFirst({
        where: { runId: input.runId, seq: BigInt(input.seq) },
      });
      if (existing) return mapEvent(existing);
      if (input.eventType === "message.delta" && input.seq < expectedSeq) {
        return this.transientEvent(input, input.seq, speaker?.id ?? null, speaker?.name ?? null);
      }
      if (input.seq !== expectedSeq) throw new Error("EVENT_SEQ_OUT_OF_ORDER");
    }
    const seq = BigInt(input.seq ?? expectedSeq);

    if (input.eventType === "message.delta") {
      const dto = this.transientEvent(input, Number(seq), speaker?.id ?? null, speaker?.name ?? null);
      await this.applySideEffects(dto);
      this.markSeq(input.runId, Number(seq));
      return dto;
    }

    let event;
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

    const dto = mapEvent(event);
    await this.applySideEffects(dto);
    this.markSeq(input.runId, Number(seq));
    this.gateway.emitEvent(dto);
    return dto;
  }

  private async nextSeq(runId: string): Promise<number> {
    const result = await this.prisma.agentEvent.aggregate({
      where: { runId },
      _max: { seq: true },
    });
    return Math.max(Number(result._max.seq ?? 0n), this.runSeqWatermarks.get(runId) ?? 0) + 1;
  }

  private markSeq(runId: string, seq: number) {
    this.runSeqWatermarks.set(runId, Math.max(this.runSeqWatermarks.get(runId) ?? 0, seq));
  }

  private transientEvent(
    input: {
      sessionId: string;
      runId: string;
      eventType: HubEventType | string;
      payload?: Record<string, unknown>;
      source?: string;
      visibility?: string;
      occurredAt?: Date;
    },
    seq: number,
    speakerAgentId: number | null,
    speakerName: string | null,
  ): HubEventDto {
    const occurredAt = input.occurredAt ?? new Date();
    return {
      id: `transient:${input.runId}:${seq}`,
      sessionId: input.sessionId,
      runId: input.runId,
      seq,
      source: input.source ?? "downstream_agent",
      eventType: input.eventType,
      visibility: input.visibility ?? "public",
      speakerAgentId,
      speakerName,
      payload: input.payload ?? {},
      occurredAt: occurredAt.toISOString(),
      persistedAt: occurredAt.toISOString(),
    };
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

    if (
      event.eventType === "diff.apply.requested" ||
      event.eventType === "diff.apply.completed" ||
      event.eventType === "diff.apply.failed"
    ) {
      const changes = await this.updateDiffApplyStatus(event);
      for (const change of changes) {
        this.gateway.emitFileChange(event.sessionId, change);
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
        await this.attachArtifactPart(event, artifact);
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
        await this.attachArtifactPart(event, artifact);
      }
    }

    if (event.eventType === "git.push.completed") {
      const commitSha = stringValue(payload.commitSha) ?? stringValue(payload.sha);
      if (commitSha) {
        const session = await this.prisma.session.findUnique({
          where: { id: event.sessionId },
          select: { metadata: true },
        });
        const metadata = asObject(session?.metadata);
        await this.prisma.session.update({
          where: { id: event.sessionId },
          data: {
            metadata: {
              ...metadata,
              latestSuccessfulPushCommitSha: commitSha,
              latestSuccessfulPushRunId: event.runId,
            } as any,
          },
        });
      }
    }

    if (event.eventType === "run.completed" || event.eventType === "run.failed" || event.eventType === "run.cancelled") {
      this.messageBuffers.delete(event.runId);
      this.artifactPartBuffers.delete(event.runId);
      this.runSeqWatermarks.delete(event.runId);
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
        contentJson: messageJsonWithParts(
          event.payload ?? {},
          fullText,
          this.takeBufferedArtifactParts(event.runId, speakerKey),
        ) as any,
        tokenCount: this.context.estimateTokens(fullText),
        status: "completed",
      },
    });
    this.gateway.emitMessage(mapMessage(message));

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

  private async attachArtifactPart(event: HubEventDto, artifact: HubArtifactDto) {
    const part = artifactMessagePart(artifact);
    const message = await this.findAssistantMessageForArtifact(event);
    if (!message) {
      this.bufferArtifactPart(event.runId, artifactBufferKey(event), part);
      return;
    }
    const contentJson = asObject(message.contentJson);
    const parts: Array<{ id?: string }> = Array.isArray(contentJson.parts)
      ? contentJson.parts.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
      : messageJsonWithParts(contentJson, message.contentText ?? "").parts;
    const nextParts = upsertPart(parts, part);
    const updated = await this.prisma.message.update({
      where: { id: message.id },
      data: { contentJson: { ...contentJson, parts: nextParts } as any, updatedAt: new Date() },
    });
    this.gateway.emitMessage(mapMessage(updated));
  }

  private async findAssistantMessageForArtifact(event: HubEventDto) {
    if (event.speakerAgentId) {
      return this.prisma.message.findFirst({
        where: {
          sessionId: event.sessionId,
          runId: event.runId,
          role: "assistant",
          agentId: event.speakerAgentId,
        },
        orderBy: { createdAt: "desc" },
      });
    }

    const run = await this.prisma.agentRun.findUnique({
      where: { id: event.runId },
      select: { assistantMessageId: true },
    });
    if (run?.assistantMessageId) {
      return this.prisma.message.findUnique({ where: { id: run.assistantMessageId } });
    }
    return this.prisma.message.findFirst({
      where: { sessionId: event.sessionId, runId: event.runId, role: "assistant" },
      orderBy: { createdAt: "desc" },
    });
  }

  private bufferArtifactPart(runId: string, key: string, part: HubMessagePartDto) {
    let runParts = this.artifactPartBuffers.get(runId);
    if (!runParts) {
      runParts = new Map();
      this.artifactPartBuffers.set(runId, runParts);
    }
    runParts.set(key, upsertPart(runParts.get(key) ?? [], part));
  }

  private takeBufferedArtifactParts(runId: string, speakerKey: string) {
    const runParts = this.artifactPartBuffers.get(runId);
    if (!runParts) return [];
    const parts = [...(runParts.get(speakerKey) ?? []), ...(runParts.get(RUN_ARTIFACT_PARTS_KEY) ?? [])];
    runParts.delete(speakerKey);
    runParts.delete(RUN_ARTIFACT_PARTS_KEY);
    if (runParts.size === 0) this.artifactPartBuffers.delete(runId);
    return parts;
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

  private async updateDiffApplyStatus(event: HubEventDto) {
    const ids = fileChangeIdsFromPayload(event.payload);
    if (ids.length === 0) return [];
    const status = diffApplyStatus(event.eventType, event.payload);
    const timestamp = event.persistedAt ?? new Date().toISOString();
    const updates: ReturnType<typeof mapFileChange>[] = [];

    for (const id of ids) {
      const existing = await this.prisma.fileChange.findFirst({
        where: { id, sessionId: event.sessionId },
      });
      if (!existing) continue;
      const metadata = asObject(existing.metadata);
      const message = stringValue(event.payload.message) ?? stringValue(event.payload.error);
      const conflicts = Array.isArray(event.payload.conflicts) ? event.payload.conflicts : null;
      const updated = await this.prisma.fileChange.update({
        where: { id },
        data: {
          metadata: {
            ...metadata,
            applyStatus: status,
            applyEventId: event.id,
            applyRunId: event.runId,
            applyMessage: message ?? null,
            applyConflicts: conflicts,
            appliedAt: status === "applied" ? timestamp : metadata.appliedAt ?? null,
            applyFailedAt: status === "failed" || status === "conflict" ? timestamp : metadata.applyFailedAt ?? null,
          } as any,
        },
      });
      updates.push(mapFileChange(updated));
    }

    return updates;
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

function fileChangeIdsFromPayload(payload: Record<string, unknown>) {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) ids.add(value.trim());
  };
  if (Array.isArray(payload.fileChangeIds)) {
    for (const item of payload.fileChangeIds) add(item);
  }
  add(payload.fileChangeId);
  if (Array.isArray(payload.changes)) {
    for (const item of payload.changes) add(asObject(item).id);
  }
  return [...ids];
}

function diffApplyStatus(eventType: string, payload: Record<string, unknown>) {
  if (eventType === "diff.apply.requested") return "queued";
  if (eventType === "diff.apply.completed") return "applied";
  const status = stringValue(payload.status);
  return status === "conflict" || (Array.isArray(payload.conflicts) && payload.conflicts.length > 0)
    ? "conflict"
    : "failed";
}

function speakerBufferKey(event: HubEventDto): string {
  return String(event.speakerAgentId ?? event.speakerName ?? stringValue(event.payload.speaker) ?? "orchestrator");
}

function artifactBufferKey(event: HubEventDto): string {
  return event.speakerAgentId || event.speakerName || event.payload.speaker ? speakerBufferKey(event) : RUN_ARTIFACT_PARTS_KEY;
}

function artifactMessagePart(artifact: HubArtifactDto): HubMessagePartDto {
  return {
    id: `artifact_${artifact.id}`,
    type: "artifact",
    title: artifact.title,
    text: artifactTextPreview(artifact),
    metadata: {
      artifactId: artifact.id,
      artifactKey: artifact.artifactKey,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      storageKind: artifact.storageKind,
      final: artifact.final,
      version: artifact.version,
      sizeBytes: artifact.sizeBytes,
      updatedAt: artifact.updatedAt,
    },
  };
}

function artifactTextPreview(artifact: HubArtifactDto) {
  const text = artifact.textContent?.trim();
  if (!text) return undefined;
  return text.length > 1200 ? `${text.slice(0, 1200)}\n...` : text;
}

function upsertPart<T extends { id?: string }>(parts: T[], part: HubMessagePartDto): Array<T | HubMessagePartDto> {
  const next = parts.filter((item) => item.id !== part.id);
  next.push(part as T & HubMessagePartDto);
  return next;
}

function normalizeChangeType(value: string) {
  return value === "added" || value === "deleted" || value === "renamed" ? value : "modified";
}
