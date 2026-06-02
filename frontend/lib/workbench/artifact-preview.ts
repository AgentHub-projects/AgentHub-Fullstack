import type { HubArtifactDto } from "@agenthub/shared";

export type ArtifactPreviewMode =
  | "image"
  | "pdf"
  | "html-inline"
  | "html-url"
  | "docx-office"
  | "docx-fallback"
  | "pptx-slides"
  | "pptx-office"
  | "pptx-fallback"
  | "text"
  | "uri"
  | "empty";

export function chooseArtifactPreviewMode(artifact: HubArtifactDto): ArtifactPreviewMode {
  if (artifact.kind === "image") return "image";
  if (artifact.kind === "pdf") return "pdf";
  if (artifact.kind === "html") return artifact.textContent ? "html-inline" : artifact.storageUri ? "html-url" : "empty";
  if (artifact.kind === "docx") return publicArtifactUrlFromArtifact(artifact) ? "docx-office" : "docx-fallback";
  if (artifact.kind === "pptx") {
    if (pptSlidesFromMetadata(artifact.metadata).length > 0) return "pptx-slides";
    return publicArtifactUrlFromArtifact(artifact) ? "pptx-office" : "pptx-fallback";
  }
  if (artifact.textContent) return "text";
  return artifact.storageUri ? "uri" : "empty";
}

export function publicArtifactUrlFromArtifact(artifact: HubArtifactDto) {
  const metadataUrl = artifact.metadata.url;
  if (typeof metadataUrl === "string" && /^https?:\/\//.test(metadataUrl)) return metadataUrl;
  if (artifact.storageUri && /^https?:\/\//.test(artifact.storageUri)) return artifact.storageUri;
  return null;
}

export function pptSlidesFromMetadata(metadata: Record<string, unknown>) {
  const raw = metadata.slides;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      return {
        title: typeof row.title === "string" ? row.title : "",
        text: typeof row.text === "string" ? row.text : typeof row.notes === "string" ? row.notes : "",
        imageUrl: typeof row.imageUrl === "string" ? row.imageUrl : "",
      };
    })
    .filter((item): item is { title: string; text: string; imageUrl: string } => Boolean(item));
}
