import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agenthub/shared";
import { ArtifactService } from "../src/services/artifact.service";
import { ContextService } from "../src/services/context.service";
import { EventStore } from "../src/services/event-store.service";
import { MemoryFactSourceRepository } from "../src/services/memory-fact-source.repository";
import { RunStateService } from "../src/services/run-state.service";

describe("fact source services", () => {
  it("replays events into refreshable run state", async () => {
    const repository = new MemoryFactSourceRepository();
    const store = new EventStore(repository);
    const runState = new RunStateService(repository);

    await store.ingestMany([
      event(1, "message.delta", { text: "hel", messageId: "msg-1" }),
      event(2, "message.delta", { text: "lo", messageId: "msg-1" }),
      event(3, "message.completed", { messageId: "msg-1" }),
      event(4, "file.change", { path: "src/app.ts", diff: "+console.log()", action: "modified" }),
      event(5, "artifact.chunk", { artifactId: "artifact-1", index: 0, content: "chunk" }),
      event(6, "artifact.completed", { artifactId: "artifact-1", kind: "log", path: "agent.log" }),
      event(7, "context.item", { id: "ctx-1", key: "decision", value: { text: "use local fallback" } })
    ]);

    const restored = await runState.refresh("run-1");

    expect(restored.timeline.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0]).toMatchObject({
      id: "msg-1",
      status: "completed",
      content: "hello"
    });
    expect(restored.fileChanges[0]).toMatchObject({
      path: "src/app.ts",
      diff: "+console.log()"
    });
    expect(restored.artifacts[0]).toMatchObject({
      id: "artifact-1",
      status: "completed",
      chunkCount: 1
    });
    expect(restored.contextItems[0]).toMatchObject({
      id: "ctx-1",
      key: "decision"
    });
  });

  it("treats duplicate runId and seq events as idempotent", async () => {
    const repository = new MemoryFactSourceRepository();
    const store = new EventStore(repository);

    const first = await store.ingest(event(1, "message.delta", { messageId: "msg-1", text: "a" }));
    const duplicate = await store.ingest({
      ...event(1, "message.delta", { messageId: "msg-1", text: "b" }),
      eventId: "event-duplicate"
    });
    const restored = await new RunStateService(repository).refresh("run-1");

    expect(first.status).toBe("created");
    expect(duplicate.status).toBe("duplicate");
    expect(restored.timeline).toHaveLength(1);
    expect(restored.messages[0].content).toBe("a");
  });

  it("does not append an earlier delta after message completion was ingested first", async () => {
    const repository = new MemoryFactSourceRepository();
    const store = new EventStore(repository);

    await store.ingest(event(2, "message.completed", { messageId: "msg-1", content: "final body" }));
    await store.ingest(event(1, "message.delta", { messageId: "msg-1", text: "stale " }));
    const restored = await new RunStateService(repository).refresh("run-1");

    expect(restored.messages[0]).toMatchObject({
      id: "msg-1",
      status: "completed",
      content: "final body"
    });
  });

  it("keeps completed message content sealed when a later delta arrives", async () => {
    const repository = new MemoryFactSourceRepository();
    const store = new EventStore(repository);

    await store.ingest(event(1, "message.delta", { messageId: "msg-1", text: "draft" }));
    await store.ingest(event(2, "message.completed", { messageId: "msg-1", content: "final" }));
    await store.ingest(event(3, "message.delta", { messageId: "msg-1", text: " corrupt" }));
    const restored = await new RunStateService(repository).refresh("run-1");

    expect(restored.messages[0]).toMatchObject({
      id: "msg-1",
      status: "completed",
      content: "final"
    });
  });

  it("rejects artifact.completed event replay when sha256 does not match assembled chunks", async () => {
    const repository = new MemoryFactSourceRepository();
    const store = new EventStore(repository);

    await store.ingest(event(1, "artifact.chunk", { artifactId: "artifact-1", index: 0, content: "hello" }));
    await expect(
      store.ingest(event(2, "artifact.completed", { artifactId: "artifact-1", sha256: sha256("not hello") }))
    ).rejects.toMatchObject({
      response: {
        code: "ARTIFACT_SHA256_MISMATCH"
      },
      status: 409
    });

    const restored = await new RunStateService(repository).refresh("run-1");
    expect(restored.timeline.map((item) => item.seq)).toEqual([1]);
    expect(restored.artifacts[0]).toMatchObject({
      id: "artifact-1",
      status: "pending"
    });
  });

  it("rejects artifact completion when sha256 does not match assembled chunks", async () => {
    const repository = new MemoryFactSourceRepository();
    const artifacts = new ArtifactService(repository);

    await artifacts.putChunk({
      artifactId: "artifact-1",
      runId: "run-1",
      index: 0,
      content: "hello"
    });

    await expect(
      artifacts.complete({
        artifactId: "artifact-1",
        runId: "run-1",
        sha256: "not-the-right-hash"
      })
    ).rejects.toMatchObject({
      response: {
        code: "ARTIFACT_SHA256_MISMATCH"
      },
      status: 409
    });
  });

  it("uses explicit local artifact fallback when OSS is not configured", async () => {
    const oldBucket = process.env.AGENTHUB_OSS_BUCKET;
    const oldRegion = process.env.AGENTHUB_OSS_REGION;
    const oldEndpoint = process.env.AGENTHUB_OSS_ENDPOINT;
    const oldDir = process.env.AGENTHUB_ARTIFACT_DIR;
    delete process.env.AGENTHUB_OSS_BUCKET;
    delete process.env.AGENTHUB_OSS_REGION;
    delete process.env.AGENTHUB_OSS_ENDPOINT;
    process.env.AGENTHUB_ARTIFACT_DIR = join(tmpdir(), "agenthub-artifact-tests");

    try {
      const repository = new MemoryFactSourceRepository();
      const artifacts = new ArtifactService(repository);
      const content = "hello fallback";
      await artifacts.putChunk({ artifactId: "artifact-2", runId: "run-1", index: 0, content });
      const completed = await artifacts.complete({
        artifactId: "artifact-2",
        runId: "run-1",
        path: "artifact.txt",
        sha256: sha256(content)
      });

      expect(completed.storageProvider).toBe("local");
      expect(completed.metadata).toMatchObject({
        fallbackReason: "OSS env is not configured; using local filesystem fallback.",
        ossConfigured: false
      });
      await expect(readFile(completed.storageKey ?? "", "utf8")).resolves.toBe(content);
    } finally {
      restoreEnv("AGENTHUB_OSS_BUCKET", oldBucket);
      restoreEnv("AGENTHUB_OSS_REGION", oldRegion);
      restoreEnv("AGENTHUB_OSS_ENDPOINT", oldEndpoint);
      restoreEnv("AGENTHUB_ARTIFACT_DIR", oldDir);
    }
  });

  it("uses explicit local context ranking when pgvector is not configured", async () => {
    const oldPgvector = process.env.AGENTHUB_PGVECTOR_ENABLED;
    const oldDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.AGENTHUB_PGVECTOR_ENABLED;
    delete process.env.DATABASE_URL;

    try {
      const repository = new MemoryFactSourceRepository();
      const context = new ContextService(repository);
      await context.upsert({
        id: "ctx-1",
        runId: "run-1",
        conversationId: "conv-1",
        kind: "note",
        key: "artifact-plan",
        value: { text: "store artifact chunks durably" }
      });

      const result = await context.search({ conversationId: "conv-1", query: "chunks" });

      expect(result.provider).toBe("local");
      expect(result.fallbackReason).toBe("pgvector is not configured; returning deterministic local ranking.");
      expect(result.items[0].id).toBe("ctx-1");
    } finally {
      restoreEnv("AGENTHUB_PGVECTOR_ENABLED", oldPgvector);
      restoreEnv("DATABASE_URL", oldDatabaseUrl);
    }
  });
});

function event(seq: number, type: AgentEvent["type"], payload: unknown): AgentEvent {
  return {
    eventId: `event-${seq}`,
    type,
    runId: "run-1",
    conversationId: "conv-1",
    agentId: "claude",
    payload,
    seq,
    ts: seq
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
