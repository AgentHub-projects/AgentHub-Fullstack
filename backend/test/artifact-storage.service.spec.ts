import { describe, expect, it, vi } from "vitest";
import {
  ArtifactStorageService,
  TEXT_ATTACHMENT_PREVIEW_CHAR_LIMIT,
  buildTextAttachmentPreview,
} from "../src/modules/hub/services/artifact-storage.service";

const now = new Date("2026-06-02T10:00:00.000Z");

describe("ArtifactStorageService presentations", () => {
  it("normalizes PowerPoint artifacts to pptx", async () => {
    const prisma = {
      artifact: {
        upsert: vi.fn(async ({ create }: any) => artifactRow(create)),
      },
      $executeRawUnsafe: vi.fn(),
    };
    const service = new ArtifactStorageService(prisma as any);

    const artifact = await service.upsertArtifact({
      sessionId: "session-1",
      runId: "run-1",
      producingEventId: "event-1",
      payload: {
        artifactKey: "deck",
        kind: "ppt",
        title: "方案演示",
        content: "slide outline",
      },
    });

    expect(prisma.artifact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        kind: "pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    }));
    expect(artifact).toMatchObject({
      kind: "pptx",
      title: "方案演示",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
  });
});

describe("ArtifactStorageService text attachment previews", () => {
  it("keeps the full preview for text attachments up to 100KB characters", () => {
    const preview = "a".repeat(TEXT_ATTACHMENT_PREVIEW_CHAR_LIMIT);

    expect(buildTextAttachmentPreview("text/plain", Buffer.from(preview, "utf8"))).toBe(preview);
  });

  it("omits text previews above 100KB characters instead of truncating them", () => {
    const oversized = "a".repeat(TEXT_ATTACHMENT_PREVIEW_CHAR_LIMIT + 1);

    expect(buildTextAttachmentPreview("text/plain", Buffer.from(oversized, "utf8"))).toBeNull();
  });

  it("does not preview non-text attachments", () => {
    expect(buildTextAttachmentPreview("application/pdf", Buffer.from("pdf text", "utf8"))).toBeNull();
  });
});

function artifactRow(overrides: Record<string, any>) {
  return {
    id: "artifact-1",
    sessionId: "session-1",
    runId: "run-1",
    producingEventId: "event-1",
    artifactKey: "deck",
    kind: "pptx",
    title: "方案演示",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    storageKind: "inline_text",
    storageUri: null,
    textContent: "slide outline",
    sha256: "sha",
    sizeBytes: 13n,
    version: 1,
    final: false,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
