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
  SessionDiffContextDto,
} from "@agenthub/shared";
import {
  BranchesOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  DownOutlined,
  ExpandOutlined,
  FileDoneOutlined,
  FileMarkdownOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  RightOutlined,
  SelectOutlined,
} from "@ant-design/icons";
import { artifactContentUrl, listArtifactVersions } from "../../lib/agenthub-api";
import { publicArtifactUrlFromArtifact, pptSlidesFromMetadata } from "../../lib/workbench/artifact-preview";
import {
  buildDiffLines,
  countChangeLines,
  diffMarker,
  parseUnifiedPatch,
} from "../../lib/workbench/diff";
import type { DiffLine } from "../../lib/workbench/types";
import {
  artifactLabel,
  fileChangeApplyLabel,
  fileChangeApplyMessage,
  fileChangeApplyStatus,
} from "../../lib/workbench/format";
import { RichText } from "./rich-text";

export function DiffPanel({
  changes,
  diffContext,
  applyingId,
  onApply,
}: {
  changes: HubFileChangeDto[];
  diffContext?: SessionDiffContextDto | null;
  applyingId?: string | null;
  onApply?: (change: HubFileChangeDto) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedFileIds, setExpandedFileIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (changes.length === 0) {
      setSelectedId(null);
      setExpandedFileIds(new Set());
      return;
    }
    if (!selectedId || !changes.some((change) => change.id === selectedId)) {
      setSelectedId(changes[0].id);
    }

    const ids = new Set(changes.map((change) => change.id));
    setExpandedFileIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      if (next.size === 0) next.add(selectedId && ids.has(selectedId) ? selectedId : changes[0].id);
      return sameStringSet(current, next) ? current : next;
    });
  }, [changes, selectedId]);

  if (changes.length === 0) return <PanelEmpty icon={<BranchesOutlined />} text="暂无文件变更" />;
  const activeChange = changes.find((change) => change.id === selectedId) ?? changes[0];

  function toggleFile(change: HubFileChangeDto) {
    setSelectedId(change.id);
    setExpandedFileIds((current) => {
      const next = new Set(current);
      if (next.has(change.id)) next.delete(change.id);
      else next.add(change.id);
      return next;
    });
  }

  function openFile(change: HubFileChangeDto) {
    setSelectedId(change.id);
    setExpandedFileIds((current) => {
      if (current.has(change.id)) return current;
      return new Set(current).add(change.id);
    });
  }

  return (
    <div className="panelScroll diffPanelLayout">
      <section className="diffReviewOverview" aria-label="文件变更总览">
        <DiffBranchContext context={diffContext} />
        <div className="diffReviewFiles">
          {changes.map((change) => {
            const expanded = expandedFileIds.has(change.id);
            const applyStatus = fileChangeApplyStatus(change);
            const active = change.id === activeChange.id;
            return (
              <article className={`diffFileBlock ${active ? "active" : ""} ${expanded ? "expanded" : ""}`} key={change.id}>
                <div className="diffReviewFile">
                  <button
                    className="diffFileToggle"
                    type="button"
                    title={expanded ? "收起文件 Diff" : "展开文件 Diff"}
                    aria-label={expanded ? `收起 ${change.path}` : `展开 ${change.path}`}
                    aria-expanded={expanded}
                    onClick={() => toggleFile(change)}
                  >
                    {expanded ? <DownOutlined /> : <RightOutlined />}
                  </button>
                  <button className="diffReviewFileMain" type="button" onClick={() => openFile(change)}>
                    <span>{change.path}</span>
                    {active && <span className="diffReviewActiveDot" aria-hidden="true" />}
                  </button>
                  <div className="diffReviewFileSide">
                    <span className="diffReviewFileStats">
                      <span className="add">+{countChangeLines(change, "add")}</span>
                      <span className="remove">-{countChangeLines(change, "remove")}</span>
                    </span>
                    <DiffFileStatus
                      change={change}
                      applyStatus={applyStatus}
                      applying={applyingId === change.id}
                      onApply={onApply}
                    />
                  </div>
                </div>
                <DiffFileDetails change={change} expanded={expanded} />
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function DiffBranchContext({ context }: { context?: SessionDiffContextDto | null }) {
  const baseRef = context?.baseRef ?? "main";
  const targetRef = context?.targetRef ?? "working tree";
  return (
    <details className="diffBranchContext">
      <summary>
        <span>{baseRef}</span>
        <span>→</span>
        <span>{targetRef}</span>
        <InfoCircleOutlined />
      </summary>
      <div className="diffBranchPopover">
        <strong>Diff 审查范围</strong>
        <p>{context?.explanation ?? "右侧 Diff 展示当前会话产生的文件变更；这里用于说明审查范围，不会切换 Git 分支。"}</p>
        {context?.projectName && (
          <dl>
            <div>
              <dt>项目</dt>
              <dd>{context.projectName}</dd>
            </div>
            <div>
              <dt>基准分支</dt>
              <dd>{baseRef}</dd>
            </div>
            {context.githubUrl && (
              <div>
                <dt>仓库</dt>
                <dd>
                  <a href={context.githubUrl} target="_blank" rel="noreferrer">
                    打开 GitHub
                  </a>
                </dd>
              </div>
            )}
          </dl>
        )}
        <small>{context?.canChangeBase ? "可以切换审查基准。" : "当前只读说明审查范围，不执行分支切换。"}</small>
      </div>
    </details>
  );
}

function DiffFileStatus({
  change,
  applyStatus,
  applying,
  onApply,
}: {
  change: HubFileChangeDto;
  applyStatus: ReturnType<typeof fileChangeApplyStatus>;
  applying: boolean;
  onApply?: (change: HubFileChangeDto) => void;
}) {
  const applyMessage = fileChangeApplyMessage(change);
  const applyLocked = applyStatus === "queued" || applyStatus === "applied";
  const showApplyButton = onApply && !applyLocked;
  return (
    <div className="diffReviewFileMeta">
      <span className={`changeType ${change.changeType}`}>{fileChangeTypeLabel(change.changeType)}</span>
      {applyStatus && <span className={`applyStatus ${applyStatus}`}>{fileChangeApplyLabel(applyStatus)}</span>}
      {showApplyButton && (
        <button
          className="diffApplyInlineButton"
          type="button"
          disabled={applying}
          onClick={() => onApply(change)}
        >
          <CheckCircleOutlined />
          <span>{applying ? "应用中" : "应用"}</span>
        </button>
      )}
      {change.afterTruncated || change.beforeTruncated ? <span className="diffMetaNote">已截断</span> : null}
      {applyMessage ? <span className={`diffApplyMessage ${applyStatus ?? ""}`}>{applyMessage}</span> : null}
    </div>
  );
}

function fileChangeTypeLabel(type: HubFileChangeDto["changeType"]) {
  if (type === "added") return "新增";
  if (type === "deleted") return "删除";
  if (type === "renamed") return "重命名";
  return "修改";
}

function DiffFileDetails({
  change,
  expanded,
}: {
  change: HubFileChangeDto;
  expanded: boolean;
}) {
  return (
    <section className={`diffViewerCard ${expanded ? "expanded" : "collapsed"}`} hidden={!expanded}>
      <UnifiedDiffView change={change} />
    </section>
  );
}

export function ArtifactPanel({
  artifacts,
  onUseSelection,
  onUseDraft,
}: {
  artifacts: HubArtifactDto[];
  onUseSelection?: (artifact: HubArtifactDto, selectedText: string) => void;
  onUseDraft?: (artifact: HubArtifactDto, editedText: string) => void;
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
          onUseDraft={onUseDraft}
        />
      )}
    </div>
  );
}

export function ArtifactViewerLayer({
  artifact,
  onClose,
  onUseSelection,
  onUseDraft,
}: {
  artifact: HubArtifactDto;
  onClose: () => void;
  onUseSelection?: (artifact: HubArtifactDto, selectedText: string) => void;
  onUseDraft?: (artifact: HubArtifactDto, editedText: string) => void;
}) {
  const [viewerMode, setViewerMode] = useState<"preview" | "code">("preview");
  const [selectedText, setSelectedText] = useState("");
  const [draftText, setDraftText] = useState("");
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
  const sourceText = displayedArtifact.textContent ?? "";
  const draftChanged = draftText !== sourceText;

  useEffect(() => {
    setDraftText(displayedArtifact.textContent ?? "");
  }, [displayedArtifact.id, displayedArtifact.version, displayedArtifact.textContent]);

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
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                onSelect={(event) =>
                  setSelectedText(
                    event.currentTarget.value.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd),
                  )
                }
              />
              <div className="artifactCodeBar">
                <button type="button" disabled={!draftChanged} onClick={() => setDraftText(sourceText)}>
                  <span>重置</span>
                </button>
                <button type="button" onClick={() => void navigator.clipboard?.writeText(draftText)}>
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
                {onUseDraft && (
                  <button
                    type="button"
                    disabled={!draftChanged || !draftText.trim()}
                    onClick={() => {
                      onUseDraft(displayedArtifact, draftText.trim());
                      onClose();
                    }}
                  >
                    <SelectOutlined />
                    <span>引用修改继续对话</span>
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

  if (artifact.kind === "html") {
    return <iframe className={`documentFrame ${expanded ? "expanded" : ""}`} title={artifact.title} src={contentUrl} sandbox="" />;
  }

  if (artifact.kind === "docx") {
    const publicUrl = publicArtifactUrlFromArtifact(artifact);
    const officeUrl = publicUrl ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(publicUrl)}` : null;
    if (officeUrl) {
      return <iframe className={`documentFrame ${expanded ? "expanded" : ""}`} title={artifact.title} src={officeUrl} />;
    }
    return <DocumentFallback title="DOCX 原始文件" text="当前文件没有可供在线渲染的公开 URL，可打开原文件查看。" />;
  }

  if (artifact.kind === "pptx") {
    return <PptxPreview artifact={artifact} contentUrl={contentUrl} expanded={expanded} />;
  }

  if (artifact.textContent) {
    return artifact.kind === "log" ? <pre>{artifact.textContent}</pre> : <RichText text={artifact.textContent} />;
  }

  if (artifact.storageUri) return <code>{artifact.storageUri}</code>;

  return <DocumentFallback title="暂无可预览内容" text="下游尚未提供文本、公开 URL 或可渲染 metadata。" />;
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
  const slides = pptSlidesFromMetadata(artifact.metadata);
  const [index, setIndex] = useState(0);
  const current = slides[index] ?? null;
  const publicUrl = publicArtifactUrlFromArtifact(artifact);
  const officeUrl = publicUrl ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(publicUrl)}` : null;

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

function DocumentFallback({ title, text }: { title: string; text: string }) {
  return (
    <div className="documentFallback">
      <FileDoneOutlined />
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

function UnifiedDiffView({ change }: { change: HubFileChangeDto }) {
  return <UnifiedDiffLines lines={buildDiffLines(change)} />;
}

function UnifiedDiffLines({ lines }: { lines: DiffLine[] }) {
  const [collapsedHunks, setCollapsedHunks] = useState<Set<string>>(() => new Set());
  const items = groupDiffLines(lines);

  function toggleHunk(id: string) {
    setCollapsedHunks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="unifiedDiff" role="table">
      {items.map((item) => {
        if (item.kind === "line") {
          return renderDiffLine(item.line, item.index);
        }

        const collapsed = collapsedHunks.has(item.id);
        return (
          <div className={`diffHunk ${collapsed ? "collapsed" : ""}`} key={item.id}>
            <div className="diffLine meta hunkMeta" role="row">
              <button
                className="diffHunkToggle"
                type="button"
                title={collapsed ? "展开代码段" : "收起代码段"}
                aria-label={collapsed ? "展开代码段" : "收起代码段"}
                aria-expanded={!collapsed}
                onClick={() => toggleHunk(item.id)}
              >
                {collapsed ? <RightOutlined /> : <DownOutlined />}
              </button>
              <code title={item.meta.text}>{diffHunkLabel(item)}</code>
            </div>
            {!collapsed && item.lines.map(({ line, index }) => renderDiffLine(line, index))}
          </div>
        );
      })}
    </div>
  );
}

function renderDiffLine(line: DiffLine, index: number) {
  if (line.kind === "meta") {
    return (
      <div className="diffLine meta fileMeta" key={`${index}-${line.text}`} role="row">
        <span className="diffHunkToggle spacer" aria-hidden="true" />
        <code>{diffMetaLabel(line.text)}</code>
      </div>
    );
  }

  return (
    <div className={`diffLine ${line.kind}`} key={`${index}-${line.oldLine ?? "x"}-${line.newLine ?? "x"}`} role="row">
      <span className="lineNo">{line.oldLine ?? ""}</span>
      <span className="lineNo">{line.newLine ?? ""}</span>
      <span className="lineMarker">{diffMarker(line.kind)}</span>
      <code>{line.text || " "}</code>
    </div>
  );
}

type DiffRenderItem =
  | { kind: "line"; line: DiffLine; index: number }
  | { kind: "hunk"; id: string; meta: DiffLine; lines: Array<{ line: DiffLine; index: number }> };

function groupDiffLines(lines: DiffLine[]): DiffRenderItem[] {
  const items: DiffRenderItem[] = [];
  let activeHunk: Extract<DiffRenderItem, { kind: "hunk" }> | null = null;

  lines.forEach((line, index) => {
    if (line.kind === "meta" && line.text.startsWith("@@")) {
      activeHunk = { kind: "hunk", id: `${index}-${line.text}`, meta: line, lines: [] };
      items.push(activeHunk);
      return;
    }

    if (activeHunk && line.kind !== "meta") {
      activeHunk.lines.push({ line, index });
      return;
    }

    items.push({ kind: "line", line, index });
  });

  return items;
}

function diffHunkLabel(item: Extract<DiffRenderItem, { kind: "hunk" }>) {
  const unchanged = item.lines.filter(({ line }) => line.kind === "context").length;
  if (unchanged > 0) return `${unchanged} unmodified lines`;
  return diffMetaLabel(item.meta.text);
}

function diffMetaLabel(text: string) {
  if (text.startsWith("@@")) return text;
  if (text.startsWith("diff --git")) return text.replace(/^diff --git\s+/, "");
  return text;
}

function sameStringSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
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
