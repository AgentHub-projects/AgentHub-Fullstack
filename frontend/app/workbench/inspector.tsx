"use client";

import { useEffect, useState } from "react";
import type React from "react";
import type {
  AgentInstanceDto,
  AgentTemplateDto,
  HubArtifactDto,
  HubArtifactVersionDto,
  HubEventDto,
  HubFileChangeDto,
} from "@agenthub/shared";
import {
  BranchesOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  ExpandOutlined,
  FileDoneOutlined,
  FileMarkdownOutlined,
  LinkOutlined,
  SelectOutlined,
} from "@ant-design/icons";
import { artifactContentUrl, listArtifactVersions } from "../../lib/agenthub-api";
import {
  buildDiffLines,
  buildFileTreeRows,
  countChangeLines,
  diffMarker,
  parseUnifiedPatch,
} from "../../lib/workbench/diff";
import type { DiffLine } from "../../lib/workbench/types";
import { artifactLabel } from "../../lib/workbench/format";
import { RichText } from "./rich-text";

export function DiffPanel({
  changes,
  applyingId,
  onApply,
}: {
  changes: HubFileChangeDto[];
  applyingId?: string | null;
  onApply?: (change: HubFileChangeDto) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (changes.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !changes.some((change) => change.id === selectedId)) {
      setSelectedId(changes[0].id);
    }
  }, [changes, selectedId]);

  if (changes.length === 0) return <PanelEmpty icon={<BranchesOutlined />} text="暂无文件变更" />;
  const activeChange = changes.find((change) => change.id === selectedId) ?? changes[0];
  const rows = buildFileTreeRows(changes);
  const additions = countChangeLines(activeChange, "add");
  const deletions = countChangeLines(activeChange, "remove");

  return (
    <div className="panelScroll diffPanelLayout">
      <section className="diffFileTree" aria-label="文件变更树">
        <div className="diffPanelHeader">
          <strong>Files</strong>
          <span>{changes.length}</span>
        </div>
        <div className="diffTreeRows">
          {rows.map((row) =>
            row.kind === "folder" ? (
              <div className="diffTreeFolder" key={row.key} style={{ paddingLeft: 10 + row.depth * 14 }}>
                {row.label}
              </div>
            ) : (
              <button
                className={`diffTreeFile ${row.change?.id === activeChange.id ? "active" : ""}`}
                key={row.key}
                type="button"
                onClick={() => row.change && setSelectedId(row.change.id)}
                style={{ paddingLeft: 10 + row.depth * 14 }}
              >
                <span>{row.label}</span>
                <code>{row.change?.changeType}</code>
              </button>
            ),
          )}
        </div>
      </section>

      <section className="diffViewerCard">
        <div className="diffViewerTop">
          <div>
            <strong>{activeChange.path}</strong>
            {activeChange.oldPath && <small>{activeChange.oldPath}</small>}
          </div>
          <div className="diffViewerActions">
            <span className={`changeType ${activeChange.changeType}`}>{activeChange.changeType}</span>
            {onApply && (
              <button
                className="ghostButton"
                type="button"
                disabled={applyingId === activeChange.id}
                onClick={() => onApply(activeChange)}
              >
                <CheckCircleOutlined />
                <span>{applyingId === activeChange.id ? "应用中" : "应用 Diff"}</span>
              </button>
            )}
          </div>
        </div>
        <div className="diffStats">
          <span className="add">+{additions}</span>
          <span className="remove">-{deletions}</span>
          {activeChange.afterTruncated || activeChange.beforeTruncated ? <span>内容已截断</span> : null}
        </div>
        <UnifiedDiffView change={activeChange} />
      </section>
    </div>
  );
}

export function ArtifactPanel({
  artifacts,
  onUseSelection,
}: {
  artifacts: HubArtifactDto[];
  onUseSelection?: (artifact: HubArtifactDto, selectedText: string) => void;
}) {
  const [activeArtifact, setActiveArtifact] = useState<HubArtifactDto | null>(null);

  if (artifacts.length === 0) return <PanelEmpty icon={<FileDoneOutlined />} text="暂无 artifact" />;
  return (
    <div className="panelScroll">
      {artifacts.map((artifact) => (
        <article className="artifactBlock" key={artifact.id}>
          <div className="artifactTop">
            <span>{artifactIcon(artifact.kind)}</span>
            <div>
              <strong>{artifact.title}</strong>
              <small>{artifact.kind} · {artifact.mimeType} · v{artifact.version} · {artifact.final ? "final" : "draft"}</small>
            </div>
            <div className="artifactActions">
              <button
                title="展开预览"
                type="button"
                onClick={() => {
                  setActiveArtifact(artifact);
                }}
              >
                <ExpandOutlined />
              </button>
              <a title="打开内容" href={artifactContentUrl(artifact.id)} target="_blank" rel="noreferrer">
                <LinkOutlined />
              </a>
            </div>
          </div>
          <ArtifactPreview artifact={artifact} />
        </article>
      ))}
      {activeArtifact && (
        <ArtifactViewerLayer
          artifact={activeArtifact}
          onClose={() => setActiveArtifact(null)}
          onUseSelection={onUseSelection}
        />
      )}
    </div>
  );
}

export function ArtifactViewerLayer({
  artifact,
  onClose,
  onUseSelection,
}: {
  artifact: HubArtifactDto;
  onClose: () => void;
  onUseSelection?: (artifact: HubArtifactDto, selectedText: string) => void;
}) {
  const [viewerMode, setViewerMode] = useState<"preview" | "code">("preview");
  const [selectedText, setSelectedText] = useState("");
  const [versions, setVersions] = useState<HubArtifactVersionDto[]>([]);
  const [activeVersion, setActiveVersion] = useState<HubArtifactVersionDto | null>(null);

  useEffect(() => {
    setViewerMode("preview");
    setSelectedText("");
    setActiveVersion(null);
    setVersions([]);
  }, [artifact.id]);

  useEffect(() => {
    let cancelled = false;
    void listArtifactVersions(artifact.id).then((result) => {
      if (cancelled) return;
      if (result.ok) setVersions(result.data.items);
      else setVersions([]);
    });
    return () => {
      cancelled = true;
    };
  }, [artifact.id]);

  const displayedArtifact = activeVersion ? artifactFromVersion(artifact, activeVersion) : artifact;

  return (
    <div className="artifactViewerLayer" role="presentation" onMouseDown={onClose}>
      <section
        className="artifactViewer"
        role="dialog"
        aria-modal="true"
        aria-label={artifact.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>{displayedArtifact.title}</strong>
            <span>{displayedArtifact.kind} · {displayedArtifact.mimeType} · v{displayedArtifact.version}</span>
          </div>
          <div className="artifactViewerActions">
            <button
              className={viewerMode === "preview" ? "active" : ""}
              type="button"
              onClick={() => setViewerMode("preview")}
            >
              <FileDoneOutlined />
              <span>预览</span>
            </button>
            <button
              className={viewerMode === "code" ? "active" : ""}
              type="button"
              disabled={!displayedArtifact.textContent}
              onClick={() => setViewerMode("code")}
            >
              <CodeOutlined />
              <span>代码</span>
            </button>
            <a href={artifactContentUrl(artifact.id)} target="_blank" rel="noreferrer">
              <LinkOutlined />
            </a>
            <button type="button" title="关闭" onClick={onClose}>
              ×
            </button>
          </div>
        </header>
        {versions.length > 0 && (
          <div className="artifactVersionBar">
            <span>版本历史</span>
            <button className={!activeVersion ? "active" : ""} type="button" onClick={() => setActiveVersion(null)}>
              当前 v{artifact.version}
            </button>
            {versions.map((version) => (
              <button
                className={activeVersion?.id === version.id ? "active" : ""}
                key={version.id}
                type="button"
                onClick={() => {
                  setActiveVersion(version);
                  setSelectedText("");
                }}
              >
                v{version.version}
              </button>
            ))}
          </div>
        )}
        <div className="artifactViewerBody">
          {viewerMode === "code" && displayedArtifact.textContent ? (
            <div className="artifactCodeEditor">
              <textarea
                spellCheck={false}
                value={displayedArtifact.textContent}
                readOnly
                onSelect={(event) =>
                  setSelectedText(
                    event.currentTarget.value.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd),
                  )
                }
              />
              <div className="artifactCodeBar">
                <button type="button" onClick={() => void navigator.clipboard?.writeText(displayedArtifact.textContent ?? "")}>
                  <CopyOutlined />
                  <span>复制全部</span>
                </button>
                {onUseSelection && (
                  <button
                    type="button"
                    disabled={!selectedText.trim()}
                    onClick={() => {
                      onUseSelection(displayedArtifact, selectedText.trim());
                      onClose();
                    }}
                  >
                    <SelectOutlined />
                    <span>引用选区</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <ArtifactPreview artifact={displayedArtifact} expanded />
          )}
        </div>
      </section>
    </div>
  );
}

export function InlineDiff({ event }: { event: HubEventDto }) {
  const patch = typeof event.payload.patch === "string" ? event.payload.patch : "";
  const path = typeof event.payload.path === "string" ? event.payload.path : "changed file";
  return (
    <div className="inlineArtifact">
      <strong><CodeOutlined /> {path}</strong>
      {patch ? <UnifiedDiffLines lines={parseUnifiedPatch(patch)} /> : <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
    </div>
  );
}

export function InlineArtifact({ event }: { event: HubEventDto }) {
  const title = typeof event.payload.title === "string" ? event.payload.title : "Artifact";
  const content = typeof event.payload.content === "string" ? event.payload.content : "";
  return (
    <div className="inlineArtifact">
      <strong><FileMarkdownOutlined /> {title}</strong>
      {content ? <RichText text={content} /> : <pre>{JSON.stringify(event.payload, null, 2)}</pre>}
    </div>
  );
}

function ArtifactPreview({ artifact, expanded = false }: { artifact: HubArtifactDto; expanded?: boolean }) {
  const contentUrl = artifactContentUrl(artifact.id);
  if (artifact.kind === "image") {
    return (
      <div className={`mediaPreview ${expanded ? "expanded" : ""}`}>
        <img alt={artifact.title} src={contentUrl} />
      </div>
    );
  }

  if (artifact.kind === "pdf") {
    return <iframe className={`documentFrame ${expanded ? "expanded" : ""}`} title={artifact.title} src={contentUrl} />;
  }

  if (artifact.kind === "html" && artifact.textContent) {
    return <iframe className={`documentFrame ${expanded ? "expanded" : ""}`} title={artifact.title} srcDoc={artifact.textContent} sandbox="" />;
  }

  if (artifact.kind === "docx") {
    return (
      <div className="documentFallback">
        <FileDoneOutlined />
        <div>
          <strong>DOCX 原始文件</strong>
          <span>后端当前提供只读下载入口；接入 HTML render 后可在此处内联预览。</span>
        </div>
      </div>
    );
  }

  if (artifact.kind === "pptx") {
    return <PptxPreview artifact={artifact} contentUrl={contentUrl} expanded={expanded} />;
  }

  if (artifact.textContent) {
    return artifact.kind === "log" ? <pre>{artifact.textContent}</pre> : <RichText text={artifact.textContent} />;
  }

  return <code>{artifact.storageUri ?? "inline artifact"}</code>;
}

function PptxPreview({
  artifact,
  contentUrl,
  expanded,
}: {
  artifact: HubArtifactDto;
  contentUrl: string;
  expanded: boolean;
}) {
  const slides = pptSlides(artifact.metadata);
  const [index, setIndex] = useState(0);
  const current = slides[index] ?? null;
  const publicUrl = publicArtifactUrl(artifact) ?? contentUrl;
  const officeUrl = publicUrl.startsWith("http") ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(publicUrl)}` : null;

  if (slides.length > 0 && current) {
    return (
      <div className={`pptxPreview ${expanded ? "expanded" : ""}`}>
        <div className="pptxSlide">
          {current.imageUrl && <img alt={current.title || `Slide ${index + 1}`} src={current.imageUrl} />}
          <div>
            <span>Slide {index + 1} / {slides.length}</span>
            <strong>{current.title || `Slide ${index + 1}`}</strong>
            {current.text && <p>{current.text}</p>}
          </div>
        </div>
        <div className="pptxControls">
          <button type="button" disabled={index === 0} onClick={() => setIndex((value) => Math.max(0, value - 1))}>
            上一页
          </button>
          <button type="button" disabled={index >= slides.length - 1} onClick={() => setIndex((value) => Math.min(slides.length - 1, value + 1))}>
            下一页
          </button>
        </div>
      </div>
    );
  }

  if (officeUrl) {
    return <iframe className={`documentFrame ${expanded ? "expanded" : ""}`} title={artifact.title} src={officeUrl} />;
  }

  return (
    <div className="documentFallback">
      <FileDoneOutlined />
      <div>
        <strong>PPTX 原始文件</strong>
        <span>可打开原文件；下游若提供 metadata.slides，将在这里按页浏览。</span>
      </div>
    </div>
  );
}

function UnifiedDiffView({ change }: { change: HubFileChangeDto }) {
  return <UnifiedDiffLines lines={buildDiffLines(change)} />;
}

function UnifiedDiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="unifiedDiff" role="table">
      {lines.map((line, index) => (
        <div className={`diffLine ${line.kind}`} key={`${index}-${line.oldLine ?? "x"}-${line.newLine ?? "x"}`} role="row">
          <span className="lineNo">{line.oldLine ?? ""}</span>
          <span className="lineNo">{line.newLine ?? ""}</span>
          <span className="lineMarker">{diffMarker(line.kind)}</span>
          <code>{line.text || " "}</code>
        </div>
      ))}
    </div>
  );
}

function PanelEmpty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="panelEmpty">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function artifactIcon(kind: HubArtifactDto["kind"]) {
  const label = artifactLabel(kind);
  if (label === "markdown") return <FileMarkdownOutlined />;
  if (label === "document") return <FileDoneOutlined />;
  return <CodeOutlined />;
}

function pptSlides(metadata: Record<string, unknown>) {
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

function publicArtifactUrl(artifact: HubArtifactDto) {
  const metadataUrl = artifact.metadata.url;
  if (typeof metadataUrl === "string" && /^https?:\/\//.test(metadataUrl)) return metadataUrl;
  if (artifact.storageUri && /^https?:\/\//.test(artifact.storageUri)) return artifact.storageUri;
  return null;
}

function artifactFromVersion(artifact: HubArtifactDto, version: HubArtifactVersionDto): HubArtifactDto {
  return {
    ...artifact,
    title: version.title,
    kind: version.kind,
    mimeType: version.mimeType,
    storageKind: version.storageKind,
    storageUri: version.storageUri,
    textContent: version.textContent,
    sha256: version.sha256,
    sizeBytes: version.sizeBytes,
    version: version.version,
    final: version.final,
    metadata: version.metadata,
    createdAt: version.createdAt,
  };
}
