import { createHash } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { AgentEvent, AgentRun, SessionDto } from "@agenthub/shared";
import {
  FACT_SOURCE_REPOSITORY,
  type FactSourceRepository,
  type FactSourceWriter
} from "./fact-source.repository";
import { ApiHttpException } from "./errors";

export interface EventIngestResult {
  eventId: string;
  runId: string;
  seq: number;
  status: "created" | "duplicate";
}

@Injectable()
export class EventStore {
  constructor(@Inject(FACT_SOURCE_REPOSITORY) private readonly repository: FactSourceRepository) {}

  async persistRun(session: SessionDto, run: AgentRun): Promise<void> {
    await this.repository.transaction((writer) => this.persistSessionAndRun(writer, session, run));
  }

  async ingest(event: AgentEvent): Promise<EventIngestResult> {
    return this.repository.transaction(async (writer) => {
      const payload = asRecord(event.payload);
      await this.ensureRunForEvent(writer, event, payload);
      const created = await writer.createEventIfAbsent(event);
      if (!created) {
        return {
          eventId: event.eventId,
          runId: event.runId,
          seq: event.seq,
          status: "duplicate"
        };
      }

      await this.derive(writer, event);
      return {
        eventId: event.eventId,
        runId: event.runId,
        seq: event.seq,
        status: "created"
      };
    });
  }

  async ingestMany(events: AgentEvent[]): Promise<EventIngestResult[]> {
    const ordered = [...events].sort((left, right) => left.seq - right.seq);
    const results: EventIngestResult[] = [];
    for (const event of ordered) {
      results.push(await this.ingest(event));
    }
    return results;
  }

  private async derive(writer: FactSourceWriter, event: AgentEvent): Promise<void> {
    const payload = asRecord(event.payload);
    switch (event.type) {
      case "text_delta":
      case "message_delta":
      case "message.delta":
        await writer.appendMessageDelta({
          id: messageId(event, payload),
          runId: event.runId,
          conversationId: event.conversationId,
          agentId: event.agentId,
          role: asString(payload.role) ?? "assistant",
          delta: messageDelta(event.payload, payload),
          metadata: payload.metadata
        });
        return;
      case "message_completed":
      case "message.completed":
        await writer.completeMessage({
          id: messageId(event, payload),
          runId: event.runId,
          conversationId: event.conversationId,
          agentId: event.agentId,
          role: asString(payload.role) ?? "assistant",
          content: asString(payload.content),
          metadata: payload.metadata
        });
        return;
      case "code_diff":
      case "file_change":
      case "file.change":
        await this.deriveFileChange(writer, event, payload);
        return;
      case "artifact_chunk":
      case "artifact.chunk":
        await this.deriveArtifactChunk(writer, event, payload);
        return;
      case "artifact_completed":
      case "artifact.completed":
        await this.deriveArtifactComplete(writer, event, payload);
        return;
      case "context_item":
      case "context.item":
        await this.deriveContextItem(writer, event, payload);
        return;
      default:
        return;
    }
  }

  private async deriveFileChange(writer: FactSourceWriter, event: AgentEvent, payload: Record<string, unknown>) {
    const path = asString(payload.path) ?? asString(payload.filePath) ?? "unknown";
    await writer.upsertFileChange({
      id: asString(payload.id) ?? `file:${event.runId}:${path}`,
      runId: event.runId,
      path,
      action: asString(payload.action) ?? asString(payload.changeType) ?? "modified",
      status: asString(payload.status) ?? "pending",
      diff: asString(payload.diff) ?? asString(payload.patch),
      sha256: asString(payload.sha256),
      metadata: payload.metadata ?? { eventId: event.eventId }
    });
  }

  private async deriveArtifactChunk(writer: FactSourceWriter, event: AgentEvent, payload: Record<string, unknown>) {
    const artifactId = artifactIdFor(event, payload);
    const path = asString(payload.path) ?? artifactId;
    const content = asString(payload.content) ?? asString(payload.data) ?? asString(payload.chunk) ?? "";
    const expectedSha256 = asString(payload.sha256);
    if (expectedSha256) {
      assertSha256(content, expectedSha256, "ARTIFACT_CHUNK_SHA256_MISMATCH", artifactId);
    }
    const index = asNumber(payload.index) ?? event.seq;
    await writer.upsertArtifact({
      id: artifactId,
      runId: event.runId,
      kind: asString(payload.kind) ?? "artifact",
      path,
      status: "pending",
      metadata: payload.metadata ?? { eventId: event.eventId }
    });
    await writer.upsertArtifactChunk({
      id: asString(payload.chunkId) ?? `chunk:${artifactId}:${index}`,
      artifactId,
      runId: event.runId,
      index,
      content,
      sha256: expectedSha256,
      byteLength: asNumber(payload.byteLength) ?? Buffer.byteLength(content, "utf8")
    });
  }

  private async deriveArtifactComplete(writer: FactSourceWriter, event: AgentEvent, payload: Record<string, unknown>) {
    const artifactId = artifactIdFor(event, payload);
    const chunks = await writer.listArtifactChunks(artifactId);
    const content = chunks
      .sort((left, right) => left.index - right.index)
      .map((chunk) => chunk.content)
      .join("");
    const actualSha256 = sha256Hex(content);
    const expectedSha256 = asString(payload.sha256);
    if (expectedSha256 && expectedSha256 !== actualSha256) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "ARTIFACT_SHA256_MISMATCH",
        message: `Artifact ${artifactId} sha256 mismatch.`,
        details: {
          expected: expectedSha256,
          actual: actualSha256
        }
      });
    }
    await writer.completeArtifact({
      id: artifactId,
      runId: event.runId,
      kind: asString(payload.kind) ?? "artifact",
      path: asString(payload.path) ?? artifactId,
      status: "completed",
      sha256: actualSha256,
      byteLength: asNumber(payload.byteLength) ?? Buffer.byteLength(content, "utf8"),
      chunkCount: asNumber(payload.chunkCount) ?? chunks.length,
      storageProvider: asString(payload.storageProvider),
      storageKey: asString(payload.storageKey),
      metadata: payload.metadata ?? { eventId: event.eventId }
    });
  }

  private async deriveContextItem(writer: FactSourceWriter, event: AgentEvent, payload: Record<string, unknown>) {
    const key = asString(payload.key) ?? asString(payload.path) ?? event.eventId;
    await writer.upsertContextItem({
      id: asString(payload.id) ?? `context:${event.conversationId}:${key}`,
      runId: asString(payload.runId) ?? event.runId,
      conversationId: asString(payload.conversationId) ?? event.conversationId,
      kind: asString(payload.kind) ?? "note",
      key,
      value: payload.value ?? payload,
      source: asString(payload.source),
      embedding: payload.embedding,
      embeddingProvider: asString(payload.embeddingProvider)
    });
  }

  private async persistSessionAndRun(writer: FactSourceWriter, session: SessionDto, run: AgentRun): Promise<void> {
    await writer.upsertSession({
      id: session.id,
      title: session.title,
      status: session.status,
      agentId: session.agentId,
      prompt: session.prompt,
      output: session.output,
      error: session.error,
      createdAt: session.createdAt
    });
    await writer.upsertAgentRun({
      id: run.id,
      sessionId: session.id,
      conversationId: run.conversationId,
      agentId: run.agentId,
      status: run.status,
      prompt: run.prompt,
      output: run.output,
      error: run.error,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt
    });
  }

  private async ensureRunForEvent(
    writer: FactSourceWriter,
    event: AgentEvent,
    payload: Record<string, unknown>
  ): Promise<void> {
    await writer.upsertSession({
      id: event.conversationId,
      title: "Current Session",
      status: sessionStatusForEvent(event, payload),
      agentId: event.agentId,
      prompt: asString(payload.prompt),
      output: asString(payload.output),
      error: errorMessageForEvent(event, payload),
      createdAt: eventTimestamp(event)
    });
    await writer.upsertAgentRun({
      id: event.runId,
      sessionId: event.conversationId,
      conversationId: event.conversationId,
      agentId: event.agentId,
      status: runStatusForEvent(event, payload),
      prompt: asString(payload.prompt),
      output: event.type === "agent_completed" ? payload : undefined,
      error: event.type === "agent_failed" ? payload : undefined,
      createdAt: eventTimestamp(event),
      startedAt: event.type === "agent_started" ? eventTimestamp(event) : undefined,
      finishedAt: isTerminalEvent(event) ? eventTimestamp(event) : undefined
    });
  }
}

function messageId(event: AgentEvent, payload: Record<string, unknown>): string {
  return event.messageId ?? asString(payload.messageId) ?? `message:${event.runId}:assistant`;
}

function artifactIdFor(event: AgentEvent, payload: Record<string, unknown>): string {
  return asString(payload.artifactId) ?? event.messageId ?? `artifact:${event.runId}`;
}

function messageDelta(payloadValue: unknown, payload: Record<string, unknown>): string {
  if (typeof payloadValue === "string") {
    return payloadValue;
  }
  return asString(payload.text) ?? asString(payload.delta) ?? asString(payload.content) ?? "";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertSha256(content: string, expected: string, code: string, artifactId: string): void {
  const actual = sha256Hex(content);
  if (actual !== expected) {
    throw new ApiHttpException(HttpStatus.CONFLICT, {
      code,
      message: `Artifact ${artifactId} sha256 mismatch.`,
      details: {
        expected,
        actual
      }
    });
  }
}

function eventTimestamp(event: AgentEvent): string {
  const date = new Date(event.ts);
  if (Number.isFinite(date.getTime())) {
    return date.toISOString();
  }
  return new Date().toISOString();
}

function runStatusForEvent(event: AgentEvent, payload: Record<string, unknown>): string {
  if (event.type === "agent_failed") {
    return "failed";
  }
  if (event.type === "agent_cancelled") {
    return "cancelled";
  }
  if (event.type === "agent_completed") {
    return "succeeded";
  }
  if (event.type === "done") {
    const status = asString(payload.status);
    if (status === "failed" || status === "cancelled" || status === "succeeded") {
      return status;
    }
    return "succeeded";
  }
  return "running";
}

function sessionStatusForEvent(event: AgentEvent, payload: Record<string, unknown>): string {
  const runStatus = runStatusForEvent(event, payload);
  if (runStatus === "failed") {
    return "failed";
  }
  if (runStatus === "succeeded") {
    return "succeeded";
  }
  if (runStatus === "cancelled") {
    return "idle";
  }
  return "running";
}

function errorMessageForEvent(event: AgentEvent, payload: Record<string, unknown>): string | undefined {
  if (event.type !== "agent_failed") {
    return undefined;
  }
  return asString(payload.message) ?? asString(payload.error) ?? "Agent run failed.";
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === "agent_completed" || event.type === "agent_failed" || event.type === "agent_cancelled" || event.type === "done";
}
