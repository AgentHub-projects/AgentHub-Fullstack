import type React from "react";
import type { HubMessagePartDto } from "@agenthub/shared";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  BranchesOutlined,
  ExpandOutlined,
  FileDoneOutlined,
  LinkOutlined,
  LoadingOutlined,
  CommentOutlined,
  PushpinFilled,
  PushpinOutlined,
  RocketOutlined,
} from "@ant-design/icons";
import { artifactContentUrl } from "../../lib/agenthub-api";
import { diffMarker, parseUnifiedPatch } from "../../lib/workbench/diff";
import { parseMarkdownBlocks, type MarkdownBlock } from "../../lib/workbench/markdown";
import type { DiffLine } from "../../lib/workbench/types";

export function RichText({ text }: { text: string }) {
  if (!text) return null;
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="richText">
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </div>
  );
}

export function MessageParts({
  parts,
  fallbackText,
  onPinPart,
  onReferencePart,
  onOpenArtifact,
  onOpenPart,
}: {
  parts?: HubMessagePartDto[];
  fallbackText: string;
  onPinPart?: (part: HubMessagePartDto) => void;
  onReferencePart?: (part: HubMessagePartDto) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
}) {
  if (!parts?.length) return <RichText text={fallbackText} />;
  return (
    <div className="richText">
      {parts.flatMap((part, index) => renderMessagePart(part, index, onPinPart, onReferencePart, onOpenArtifact, onOpenPart))}
    </div>
  );
}

function renderMessagePart(
  part: HubMessagePartDto,
  index: number,
  onPinPart?: (part: HubMessagePartDto) => void,
  onReferencePart?: (part: HubMessagePartDto) => void,
  onOpenArtifact?: (artifactId: string) => void,
  onOpenPart?: (part: HubMessagePartDto) => void,
): React.ReactNode[] {
  if (part.type === "code") {
    return [
      <CodeBlock
        key={part.id || index}
        text={part.text ?? ""}
        language={part.language}
        pinned={part.pinned}
        onPin={onPinPart ? () => onPinPart(part) : undefined}
        onReference={onReferencePart ? () => onReferencePart(part) : undefined}
        onExpand={onOpenPart ? () => onOpenPart(part) : undefined}
      />,
    ];
  }
  if (part.type === "deploy_status") {
    return [<DeployStatusPart key={part.id || index} part={part} onPinPart={onPinPart} onReferencePart={onReferencePart} onOpenPart={onOpenPart} />];
  }
  if (part.type === "link_preview") {
    return [<LinkPreviewPart key={part.id || index} part={part} onPinPart={onPinPart} onReferencePart={onReferencePart} onOpenPart={onOpenPart} />];
  }
  if (part.type === "image") {
    return [<ImagePart key={part.id || index} part={part} onPinPart={onPinPart} onReferencePart={onReferencePart} onOpenPart={onOpenPart} />];
  }
  if (part.type === "file") {
    return [<FilePart key={part.id || index} part={part} onPinPart={onPinPart} onReferencePart={onReferencePart} onOpenPart={onOpenPart} />];
  }
  if (part.type === "diff") {
    return [<DiffPart key={part.id || index} part={part} onPinPart={onPinPart} onReferencePart={onReferencePart} onOpenPart={onOpenPart} />];
  }
  if (part.type === "artifact") {
    return [<ArtifactPart key={part.id || index} part={part} onPinPart={onPinPart} onReferencePart={onReferencePart} onOpenArtifact={onOpenArtifact} onOpenPart={onOpenPart} />];
  }
  if (part.type !== "text") {
    return [
      <div className="messageCardPart" key={part.id || index}>
        <div>
          <strong>{part.title ?? part.type}</strong>
          <span className="messageCardActions">
            {onOpenPart && (
              <button type="button" title="展开预览" onClick={() => onOpenPart(part)}>
                <ExpandOutlined />
              </button>
            )}
            {onPinPart && (
              <button type="button" title={part.pinned ? "取消 Pin 这个 part" : "Pin 这个 part"} onClick={() => onPinPart(part)}>
                {part.pinned ? <PushpinFilled /> : <PushpinOutlined />}
              </button>
            )}
            {onReferencePart && (
              <button type="button" title="引用这个 part" onClick={() => onReferencePart(part)}>
                <CommentOutlined />
              </button>
            )}
          </span>
        </div>
        {part.url && <span>{part.url}</span>}
        {part.text && <small>{part.text}</small>}
      </div>,
    ];
  }
  return parseMarkdownBlocks(part.text ?? "").map((block, blockIndex) =>
    renderMarkdownBlock(block, `${part.id || index}-${blockIndex}`),
  );
}

function DiffPart({
  part,
  onPinPart,
  onReferencePart,
  onOpenPart,
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
  onReferencePart?: (part: HubMessagePartDto) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
}) {
  const path = stringMetadata(part.metadata, "path") ?? part.title ?? "Diff";
  const changeType = stringMetadata(part.metadata, "changeType");
  const patch = part.text?.trim() ? part.text : stringMetadata(part.metadata, "patch") ?? "";
  const before = stringMetadata(part.metadata, "beforeContent");
  const after = stringMetadata(part.metadata, "afterContent");
  const lines = patch.trim() ? parseUnifiedPatch(patch) : before || after ? beforeAfterLines(before ?? "", after ?? "") : [];
  return (
    <div className="diffMessagePart">
      <div className="diffMessageTop">
        <span className="diffMessageIcon">
          <BranchesOutlined />
        </span>
        <div>
          <strong>{path}</strong>
          <span>{changeType ?? "diff"}</span>
        </div>
        <div>
          {onOpenPart && (
            <button type="button" title="展开预览" onClick={() => onOpenPart(part)}>
              <ExpandOutlined />
            </button>
          )}
          {part.url && (
            <a title="打开 Diff" href={part.url} target="_blank" rel="noreferrer">
              <LinkOutlined />
            </a>
          )}
          {onPinPart && (
            <button type="button" title={part.pinned ? "取消 Pin Diff" : "Pin Diff"} onClick={() => onPinPart(part)}>
              {part.pinned ? <PushpinFilled /> : <PushpinOutlined />}
            </button>
          )}
          {onReferencePart && (
            <button type="button" title="引用 Diff" onClick={() => onReferencePart(part)}>
              <CommentOutlined />
            </button>
          )}
        </div>
      </div>
      {lines.length ? <DiffLines lines={lines} /> : <pre>{JSON.stringify(part.metadata ?? {}, null, 2)}</pre>}
    </div>
  );
}

function DiffLines({ lines }: { lines: DiffLine[] }) {
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

function beforeAfterLines(before: string, after: string): DiffLine[] {
  return [
    { kind: "meta", text: "--- before" },
    ...before.replace(/\r\n/g, "\n").split("\n").map((text, index) => ({ kind: "remove" as const, oldLine: index + 1, text })),
    { kind: "meta", text: "+++ after" },
    ...after.replace(/\r\n/g, "\n").split("\n").map((text, index) => ({ kind: "add" as const, newLine: index + 1, text })),
  ];
}

function FilePart({
  part,
  onPinPart,
  onReferencePart,
  onOpenPart,
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
  onReferencePart?: (part: HubMessagePartDto) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
}) {
  const mimeType = stringMetadata(part.metadata, "mimeType");
  const sizeBytes = numberMetadata(part.metadata, "sizeBytes");
  return (
    <div className="fileMessagePart">
      <div className="fileMessageIcon">
        <FileDoneOutlined />
      </div>
      <div className="fileMessageBody">
        <div className="fileMessageTop">
          <div>
            <strong>{part.title ?? "文件附件"}</strong>
            <span>
              {[mimeType, sizeBytes ? formatBytes(sizeBytes) : null].filter(Boolean).join(" · ") || "附件"}
            </span>
          </div>
          <div>
            {onOpenPart && (
              <button type="button" title="展开预览" onClick={() => onOpenPart(part)}>
                <ExpandOutlined />
              </button>
            )}
            {part.url && (
              <a title="打开文件" href={part.url} target="_blank" rel="noreferrer">
                <LinkOutlined />
              </a>
            )}
            {onPinPart && (
              <button type="button" title={part.pinned ? "取消 Pin 文件" : "Pin 文件"} onClick={() => onPinPart(part)}>
                {part.pinned ? <PushpinFilled /> : <PushpinOutlined />}
              </button>
            )}
            {onReferencePart && (
              <button type="button" title="引用文件" onClick={() => onReferencePart(part)}>
                <CommentOutlined />
              </button>
            )}
          </div>
        </div>
        {part.text?.trim() && <pre>{part.text}</pre>}
      </div>
    </div>
  );
}

function ImagePart({
  part,
  onPinPart,
  onReferencePart,
  onOpenPart,
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
  onReferencePart?: (part: HubMessagePartDto) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
}) {
  return (
    <div className="imageMessagePart">
      <div className="imageMessageTop">
        <strong>{part.title ?? "图片附件"}</strong>
        <div>
          {onOpenPart && (
            <button type="button" title="展开预览" onClick={() => onOpenPart(part)}>
              <ExpandOutlined />
            </button>
          )}
          {part.url && (
            <a title="打开图片" href={part.url} target="_blank" rel="noreferrer">
              <LinkOutlined />
            </a>
          )}
          {onPinPart && (
            <button type="button" title={part.pinned ? "取消 Pin 图片" : "Pin 图片"} onClick={() => onPinPart(part)}>
              {part.pinned ? <PushpinFilled /> : <PushpinOutlined />}
            </button>
          )}
          {onReferencePart && (
            <button type="button" title="引用图片" onClick={() => onReferencePart(part)}>
              <CommentOutlined />
            </button>
          )}
        </div>
      </div>
      {part.url ? (
        <img alt={part.title ?? "图片附件"} src={part.url} />
      ) : (
        <small>{part.text ?? "图片已上传"}</small>
      )}
    </div>
  );
}

export function ArtifactPart({
  part,
  onPinPart,
  onReferencePart,
  onOpenArtifact,
  onOpenPart,
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
  onReferencePart?: (part: HubMessagePartDto) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
}) {
  const artifactId = stringMetadata(part.metadata, "artifactId");
  const kind = stringMetadata(part.metadata, "kind") ?? "artifact";
  const mimeType = stringMetadata(part.metadata, "mimeType") ?? "application/octet-stream";
  const version = numberMetadata(part.metadata, "version");
  const final = booleanMetadata(part.metadata, "final");
  const contentUrl = artifactId ? artifactContentUrl(artifactId) : part.url;
  const title = part.title ?? "Artifact";
  const canOpenArtifact = Boolean(artifactId && onOpenArtifact);
  const canOpenPart = Boolean(!canOpenArtifact && onOpenPart);
  const canExpand = canOpenArtifact || canOpenPart;
  const openArtifact = () => {
    if (artifactId && onOpenArtifact) onOpenArtifact(artifactId);
  };
  const openPreview = () => {
    if (canOpenArtifact) {
      openArtifact();
      return;
    }
    onOpenPart?.(part);
  };
  return (
    <div
      className={`artifactMessagePart ${kind} ${canExpand ? "clickable" : ""}`}
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      onClick={canExpand ? openPreview : undefined}
      onKeyDown={
        canExpand
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              openPreview();
            }
          : undefined
      }
    >
      <div className="artifactMessageTop">
        <span className="artifactMessageIcon"><FileDoneOutlined /></span>
        <div>
          <strong>{title}</strong>
          <small>
            {kind} · {mimeType}
            {version ? ` · v${version}` : ""}
            {final ? " · final" : ""}
          </small>
        </div>
        <div className="artifactMessageActions" onClick={(event) => event.stopPropagation()}>
          {canExpand && (
            <button type="button" title="展开预览" onClick={openPreview}>
              <ExpandOutlined />
            </button>
          )}
          {contentUrl && (
            <a title="打开预览" href={contentUrl} target="_blank" rel="noreferrer">
              <LinkOutlined />
            </a>
          )}
          {onPinPart && (
            <button type="button" title={part.pinned ? "取消 Pin 这个 artifact" : "Pin 这个 artifact"} onClick={() => onPinPart(part)}>
              {part.pinned ? <PushpinFilled /> : <PushpinOutlined />}
            </button>
          )}
          {onReferencePart && (
            <button type="button" title="引用 artifact" onClick={() => onReferencePart(part)}>
              <CommentOutlined />
            </button>
          )}
        </div>
      </div>
      <ArtifactInlinePreview kind={kind} title={title} contentUrl={contentUrl} text={part.text} />
    </div>
  );
}

function ArtifactInlinePreview({
  kind,
  title,
  contentUrl,
  text,
}: {
  kind: string;
  title: string;
  contentUrl?: string;
  text?: string;
}) {
  if (kind === "image" && contentUrl) {
    return (
      <div className="artifactMessageMedia">
        <img alt={title} src={contentUrl} />
      </div>
    );
  }
  if (kind === "html" && contentUrl) {
    return <iframe className="artifactMessageFrame" title={title} src={contentUrl} sandbox="" />;
  }
  if (text?.trim()) {
    return <div className="artifactMessageText"><RichText text={text} /></div>;
  }
  return <small className="artifactMessageHint">产物已保存，可打开预览或在右侧 Artifacts 面板展开。</small>;
}

function LinkPreviewPart({
  part,
  onPinPart,
  onReferencePart,
  onOpenPart,
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
  onReferencePart?: (part: HubMessagePartDto) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
}) {
  const description = stringMetadata(part.metadata, "description") ?? part.text ?? "";
  return (
    <div className="linkPreviewPart">
      <div>
        <strong>{part.title ?? part.url ?? "网页预览"}</strong>
        {description && <span>{description}</span>}
        {part.url && (
          <a href={part.url} target="_blank" rel="noreferrer">
            {part.url}
          </a>
        )}
      </div>
      <div className="linkPreviewActions">
        {onOpenPart && (
          <button type="button" title="展开预览" onClick={() => onOpenPart(part)}>
            <ExpandOutlined />
          </button>
        )}
        {onPinPart && (
          <button type="button" title={part.pinned ? "取消 Pin 网页预览" : "Pin 网页预览"} onClick={() => onPinPart(part)}>
            {part.pinned ? <PushpinFilled /> : <PushpinOutlined />}
          </button>
        )}
        {onReferencePart && (
          <button type="button" title="引用网页预览" onClick={() => onReferencePart(part)}>
            <CommentOutlined />
          </button>
        )}
      </div>
    </div>
  );
}

function DeployStatusPart({
  part,
  onPinPart,
  onReferencePart,
  onOpenPart,
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
  onReferencePart?: (part: HubMessagePartDto) => void;
  onOpenPart?: (part: HubMessagePartDto) => void;
}) {
  const status = stringMetadata(part.metadata, "status") ?? "queued";
  const commitSha = stringMetadata(part.metadata, "commitSha") ?? "";
  const projectName = stringMetadata(part.metadata, "projectName") ?? "Project";
  const target = stringMetadata(part.metadata, "target") ?? "static";
  const targetLabel = stringMetadata(part.metadata, "targetLabel") ?? deploymentTargetLabel(target);
  const errorMessage = stringMetadata(part.metadata, "errorMessage") ?? part.text ?? "";
  const sourceArchiveUrl = stringMetadata(part.metadata, "sourceArchiveUrl");
  const shortSha = commitSha ? commitSha.slice(0, 12) : "";
  return (
    <div className={`deployStatusPart ${deployStatusClass(status)}`}>
      <div className="deployStatusIcon">{deployStatusIcon(status)}</div>
      <div>
        <strong>{part.title ?? "部署状态"}</strong>
        <span>
          {projectName}
          {` · ${targetLabel}`}
          {shortSha ? ` · ${shortSha}` : ""}
        </span>
        {part.url && target !== "source_archive" && (
          <a href={part.url} target="_blank" rel="noreferrer">
            预览地址：{part.url}
          </a>
        )}
        {sourceArchiveUrl && (
          <a href={sourceArchiveUrl} target="_blank" rel="noreferrer">
            下载源码包
          </a>
        )}
        {status === "failed" && errorMessage && <small>{errorMessage}</small>}
      </div>
      <div className="deployStatusActions">
        {onOpenPart && (
          <button type="button" title="展开预览" onClick={() => onOpenPart(part)}>
            <ExpandOutlined />
          </button>
        )}
        {onPinPart && (
          <button type="button" title={part.pinned ? "取消 Pin 部署状态" : "Pin 部署状态"} onClick={() => onPinPart(part)}>
            {part.pinned ? <PushpinFilled /> : <PushpinOutlined />}
          </button>
        )}
        {onReferencePart && (
          <button type="button" title="引用部署状态" onClick={() => onReferencePart(part)}>
            <CommentOutlined />
          </button>
        )}
      </div>
    </div>
  );
}

function renderMarkdownBlock(block: MarkdownBlock, key: React.Key): React.ReactNode {
  if (block.kind === "heading") {
    const Tag = block.level <= 1 ? "h2" : "h3";
    return <Tag key={key}>{block.text}</Tag>;
  }
  if (block.kind === "code") {
    return <CodeBlock key={key} text={block.text} language={block.language} />;
  }
  if (block.kind === "ul") {
    return <ul key={key}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>;
  }
  if (block.kind === "ol") {
    return <ol key={key}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>;
  }
  if (block.kind === "quote") {
    return <blockquote key={key}>{block.text}</blockquote>;
  }
  if (block.kind === "table") {
    return (
      <div className="markdownTableWrap" key={key}>
        <table>
          <thead>
            <tr>{block.headers.map((header, cellIndex) => <th key={cellIndex}>{header}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.headers.map((_, cellIndex) => <td key={cellIndex}>{row[cellIndex] ?? ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <p key={key}>{block.text}</p>;
}

function CodeBlock({
  text,
  language,
  pinned,
  onPin,
  onReference,
  onExpand,
}: {
  text: string;
  language?: string;
  pinned?: boolean;
  onPin?: () => void;
  onReference?: () => void;
  onExpand?: () => void;
}) {
  return (
    <div className="codeBlock">
      <div className="codeBlockHeader">
        <span>{language || "code"}</span>
        <div>
          {onExpand && (
            <button type="button" title="展开预览" onClick={onExpand}>
              <ExpandOutlined />
            </button>
          )}
          {onPin && (
            <button type="button" title={pinned ? "取消 Pin 这段代码" : "Pin 这段代码"} onClick={onPin}>
              {pinned ? <PushpinFilled /> : <PushpinOutlined />}
            </button>
          )}
          <button type="button" title="复制代码" onClick={() => copyText(text)}>
            <CopyOutlined />
          </button>
          {onReference && (
            <button type="button" title="引用代码" onClick={onReference}>
              <CommentOutlined />
            </button>
          )}
        </div>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export function MessagePartViewerLayer({ part, onClose }: { part: HubMessagePartDto; onClose: () => void }) {
  const copyableText = partCopyText(part);
  return (
    <div className="messagePartViewerLayer" role="presentation" onMouseDown={onClose}>
      <section
        className="messagePartViewer"
        role="dialog"
        aria-modal="true"
        aria-label={partTitle(part)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong>{partTitle(part)}</strong>
            <span>{partSubtitle(part)}</span>
          </div>
          <div className="messagePartViewerActions">
            {copyableText && (
              <button type="button" title="复制内容" onClick={() => copyText(copyableText)}>
                <CopyOutlined />
                <span>复制</span>
              </button>
            )}
            {part.url && (
              <a title="打开原始地址" href={part.url} target="_blank" rel="noreferrer">
                <LinkOutlined />
              </a>
            )}
            <button type="button" title="关闭" onClick={onClose}>
              ×
            </button>
          </div>
        </header>
        <div className="messagePartViewerBody">
          <ExpandedPartPreview part={part} />
        </div>
      </section>
    </div>
  );
}

function ExpandedPartPreview({ part }: { part: HubMessagePartDto }) {
  if (part.type === "image") {
    return part.url ? (
      <div className="messagePartMediaPreview">
        <img alt={part.title ?? "图片附件"} src={part.url} />
      </div>
    ) : (
      <PartFallback part={part} />
    );
  }

  if (part.type === "file") {
    return <ExpandedFilePart part={part} />;
  }

  if (part.type === "diff") {
    const patch = part.text?.trim() ? part.text : stringMetadata(part.metadata, "patch") ?? "";
    const before = stringMetadata(part.metadata, "beforeContent");
    const after = stringMetadata(part.metadata, "afterContent");
    const lines = patch.trim() ? parseUnifiedPatch(patch) : before || after ? beforeAfterLines(before ?? "", after ?? "") : [];
    return lines.length ? (
      <div className="messagePartDiffPreview">
        <DiffLines lines={lines} />
      </div>
    ) : (
      <PartFallback part={part} />
    );
  }

  if (part.type === "link_preview") {
    const description = stringMetadata(part.metadata, "description") ?? part.text ?? "";
    return (
      <div className="messagePartDetailCard">
        <strong>{part.title ?? "网页预览"}</strong>
        {description && <p>{description}</p>}
        {part.url && (
          <a href={part.url} target="_blank" rel="noreferrer">
            {part.url}
          </a>
        )}
        <PartMetadata part={part} />
      </div>
    );
  }

  if (part.type === "deploy_status") {
    return <ExpandedDeployStatus part={part} />;
  }

  if (part.type === "code") {
    return <pre className="messagePartCodePreview">{part.text ?? ""}</pre>;
  }

  if (part.text?.trim()) {
    return <pre className="messagePartCodePreview">{part.text}</pre>;
  }

  return <PartFallback part={part} />;
}

function ExpandedFilePart({ part }: { part: HubMessagePartDto }) {
  const mimeType = stringMetadata(part.metadata, "mimeType") ?? "";
  if (part.url && mimeType.startsWith("image/")) {
    return (
      <div className="messagePartMediaPreview">
        <img alt={part.title ?? "文件附件"} src={part.url} />
      </div>
    );
  }

  if (part.url && (mimeType === "application/pdf" || mimeType === "text/html")) {
    return <iframe className="messagePartFramePreview" title={part.title ?? "文件附件"} src={part.url} />;
  }

  if (part.text?.trim()) {
    return <pre className="messagePartCodePreview">{part.text}</pre>;
  }

  return <PartFallback part={part} />;
}

function ExpandedDeployStatus({ part }: { part: HubMessagePartDto }) {
  const status = stringMetadata(part.metadata, "status") ?? "queued";
  const commitSha = stringMetadata(part.metadata, "commitSha") ?? "";
  const projectName = stringMetadata(part.metadata, "projectName") ?? "Project";
  const target = stringMetadata(part.metadata, "target") ?? "static";
  const targetLabel = stringMetadata(part.metadata, "targetLabel") ?? deploymentTargetLabel(target);
  const errorMessage = stringMetadata(part.metadata, "errorMessage") ?? part.text ?? "";
  const sourceArchiveUrl = stringMetadata(part.metadata, "sourceArchiveUrl");
  return (
    <div className={`messagePartDetailCard deploy ${deployStatusClass(status)}`}>
      <strong>{part.title ?? "部署状态"}</strong>
      <dl>
        <div>
          <dt>状态</dt>
          <dd>{status}</dd>
        </div>
        <div>
          <dt>项目</dt>
          <dd>{projectName}</dd>
        </div>
        <div>
          <dt>目标</dt>
          <dd>{targetLabel}</dd>
        </div>
        {commitSha && (
          <div>
            <dt>Commit</dt>
            <dd>{commitSha}</dd>
          </div>
        )}
      </dl>
      {part.url && target !== "source_archive" && (
        <a href={part.url} target="_blank" rel="noreferrer">
          预览地址：{part.url}
        </a>
      )}
      {sourceArchiveUrl && (
        <a href={sourceArchiveUrl} target="_blank" rel="noreferrer">
          下载源码包
        </a>
      )}
      {status === "failed" && errorMessage && <p>{errorMessage}</p>}
    </div>
  );
}

function PartFallback({ part }: { part: HubMessagePartDto }) {
  return (
    <div className="messagePartDetailCard">
      <strong>{part.title ?? part.type}</strong>
      {part.url && (
        <a href={part.url} target="_blank" rel="noreferrer">
          {part.url}
        </a>
      )}
      {part.text && <p>{part.text}</p>}
      <PartMetadata part={part} />
    </div>
  );
}

function PartMetadata({ part }: { part: HubMessagePartDto }) {
  const entries = Object.entries(part.metadata ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (entries.length === 0) return null;
  return (
    <dl>
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function partTitle(part: HubMessagePartDto) {
  if (part.title) return part.title;
  if (part.type === "image") return "图片附件";
  if (part.type === "file") return "文件附件";
  if (part.type === "link_preview") return "网页预览";
  if (part.type === "diff") return stringMetadata(part.metadata, "path") ?? "Diff";
  if (part.type === "deploy_status") return "部署状态";
  if (part.type === "code") return part.language ?? "代码";
  return part.type;
}

function partSubtitle(part: HubMessagePartDto) {
  if (part.type === "file") {
    const mimeType = stringMetadata(part.metadata, "mimeType");
    const sizeBytes = numberMetadata(part.metadata, "sizeBytes");
    return [mimeType, sizeBytes ? formatBytes(sizeBytes) : null].filter(Boolean).join(" · ") || "附件";
  }
  if (part.type === "diff") return stringMetadata(part.metadata, "changeType") ?? "diff";
  if (part.type === "deploy_status") {
    const status = stringMetadata(part.metadata, "status") ?? "queued";
    const target = stringMetadata(part.metadata, "target") ?? "static";
    return `${deploymentTargetLabel(target)} · ${status}`;
  }
  if (part.type === "link_preview") return part.url ?? "Open Graph";
  if (part.type === "code") return part.language ?? "code";
  return part.type;
}

function partCopyText(part: HubMessagePartDto) {
  if (part.text?.trim()) return part.text;
  if (part.type === "diff") return stringMetadata(part.metadata, "patch");
  if (part.url) return part.url;
  return null;
}

function copyText(text: string) {
  void navigator.clipboard?.writeText(text);
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberMetadata(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanMetadata(metadata: Record<string, unknown> | undefined, key: string) {
  return metadata?.[key] === true;
}

function deployStatusClass(status: string) {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "queued";
}

function deployStatusIcon(status: string) {
  if (status === "completed") return <CheckCircleOutlined />;
  if (status === "failed") return <CloseCircleOutlined />;
  if (status === "running") return <LoadingOutlined />;
  return <RocketOutlined />;
}

function deploymentTargetLabel(target: string) {
  if (target === "container") return "容器化部署";
  if (target === "source_archive") return "源码包";
  return "静态站点";
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}
