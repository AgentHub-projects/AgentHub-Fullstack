import { describe, expect, it } from "vitest";
import type { HubArtifactDto } from "@agenthub/shared";
import { chooseArtifactPreviewMode, pptSlidesFromMetadata, publicArtifactUrlFromArtifact } from "./artifact-preview";

describe("artifact preview helpers", () => {
  it("prefers ppt metadata slides before office preview", () => {
    const artifact = artifactFixture({
      kind: "pptx",
      metadata: {
        url: "https://cdn.example/demo.pptx",
        slides: [{ title: "首页", text: "摘要", imageUrl: "https://cdn.example/slide.png" }],
      },
    });

    expect(chooseArtifactPreviewMode(artifact)).toBe("pptx-slides");
    expect(pptSlidesFromMetadata(artifact.metadata)).toHaveLength(1);
  });

  it("uses office preview only for public document urls", () => {
    expect(chooseArtifactPreviewMode(artifactFixture({
      kind: "docx",
      storageUri: "https://cdn.example/report.docx",
    }))).toBe("docx-office");
    expect(chooseArtifactPreviewMode(artifactFixture({
      kind: "docx",
      storageUri: "oss://bucket/report.docx",
    }))).toBe("docx-fallback");
  });

  it("returns empty mode when no content or uri is available", () => {
    const artifact = artifactFixture({ kind: "html", textContent: null, storageUri: null });

    expect(publicArtifactUrlFromArtifact(artifact)).toBeNull();
    expect(chooseArtifactPreviewMode(artifact)).toBe("empty");
  });
});

function artifactFixture(overrides: Partial<HubArtifactDto> = {}): HubArtifactDto {
  return {
    id: "artifact-1",
    sessionId: "session-1",
    runId: "run-1",
    producingEventId: "event-1",
    artifactKey: "preview",
    kind: "html",
    title: "预览",
    mimeType: "text/html",
    storageKind: "inline_text",
    storageUri: null,
    textContent: "<main />",
    sha256: "sha",
    sizeBytes: 8,
    version: 1,
    final: true,
    metadata: {},
    createdAt: "2026-06-02T09:00:00.000Z",
    updatedAt: "2026-06-02T09:00:00.000Z",
    ...overrides,
  };
}
