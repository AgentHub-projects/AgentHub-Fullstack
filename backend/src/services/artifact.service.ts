import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { ArtifactChunkDto, ArtifactDto } from "@agenthub/shared";
import { ApiHttpException } from "./errors";
import {
  FACT_SOURCE_REPOSITORY,
  type FactSourceRepository
} from "./fact-source.repository";

export interface ArtifactChunkRequest {
  artifactId: string;
  runId: string;
  index: number;
  content: string;
  kind?: string;
  path?: string;
  sha256?: string;
}

export interface ArtifactCompleteRequest {
  artifactId: string;
  runId: string;
  kind?: string;
  path?: string;
  sha256?: string;
}

export interface ArtifactStorageStatus {
  provider: "local";
  directory: string;
  reason: string;
  ossConfigured: boolean;
}

@Injectable()
export class ArtifactService {
  constructor(@Inject(FACT_SOURCE_REPOSITORY) private readonly repository: FactSourceRepository) {}

  storageStatus(): ArtifactStorageStatus {
    const directory = process.env.AGENTHUB_ARTIFACT_DIR ?? join(tmpdir(), "agenthub-artifacts");
    const ossConfigured = Boolean(
      process.env.AGENTHUB_OSS_BUCKET && process.env.AGENTHUB_OSS_REGION && process.env.AGENTHUB_OSS_ENDPOINT
    );
    return {
      provider: "local",
      directory,
      ossConfigured,
      reason: ossConfigured
        ? "OSS env is configured but no OSS adapter is bundled; using local filesystem fallback."
        : "OSS env is not configured; using local filesystem fallback."
    };
  }

  async putChunk(input: ArtifactChunkRequest): Promise<ArtifactChunkDto> {
    if (input.sha256) {
      assertSha256(input.content, input.sha256, "ARTIFACT_CHUNK_SHA256_MISMATCH");
    }

    return this.repository.transaction(async (writer) => {
      await writer.upsertArtifact({
        id: input.artifactId,
        runId: input.runId,
        kind: input.kind ?? "artifact",
        path: input.path ?? input.artifactId,
        status: "pending"
      });
      return writer.upsertArtifactChunk({
        id: `chunk:${input.artifactId}:${input.index}`,
        artifactId: input.artifactId,
        runId: input.runId,
        index: input.index,
        content: input.content,
        sha256: input.sha256,
        byteLength: Buffer.byteLength(input.content, "utf8")
      });
    });
  }

  async complete(input: ArtifactCompleteRequest): Promise<ArtifactDto> {
    const chunks = await this.repository.listArtifactChunks(input.artifactId);
    const content = chunks
      .sort((left, right) => left.index - right.index)
      .map((chunk) => chunk.content)
      .join("");
    const actualSha256 = sha256Hex(content);
    if (input.sha256 && input.sha256 !== actualSha256) {
      throw new ApiHttpException(HttpStatus.CONFLICT, {
        code: "ARTIFACT_SHA256_MISMATCH",
        message: `Artifact ${input.artifactId} sha256 mismatch.`,
        details: {
          expected: input.sha256,
          actual: actualSha256
        }
      });
    }

    const storage = this.storageStatus();
    const storageKey = await this.writeLocalArtifact(storage, input, content);
    return this.repository.transaction((writer) =>
      writer.completeArtifact({
        id: input.artifactId,
        runId: input.runId,
        kind: input.kind ?? "artifact",
        path: input.path ?? input.artifactId,
        status: "completed",
        sha256: actualSha256,
        byteLength: Buffer.byteLength(content, "utf8"),
        chunkCount: chunks.length,
        storageProvider: storage.provider,
        storageKey,
        metadata: {
          fallbackReason: storage.reason,
          ossConfigured: storage.ossConfigured
        }
      })
    );
  }

  private async writeLocalArtifact(
    storage: ArtifactStorageStatus,
    input: ArtifactCompleteRequest,
    content: string
  ): Promise<string> {
    await mkdir(storage.directory, { recursive: true });
    const fileName = `${safeFileSegment(input.artifactId)}-${safeFileSegment(basename(input.path ?? input.artifactId))}`;
    const storageKey = join(storage.directory, fileName);
    await writeFile(storageKey, content, "utf8");
    return storageKey;
  }
}

function assertSha256(content: string, expected: string, code: string): void {
  const actual = sha256Hex(content);
  if (actual !== expected) {
    throw new ApiHttpException(HttpStatus.CONFLICT, {
      code,
      message: "Artifact sha256 mismatch.",
      details: { expected, actual }
    });
  }
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
