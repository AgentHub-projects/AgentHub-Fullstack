import type React from "react";
import type { HubMessagePartDto } from "@agenthub/shared";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  ExpandOutlined,
  FileDoneOutlined,
  LinkOutlined,
  LoadingOutlined,
  PushpinFilled,
  PushpinOutlined,
  RocketOutlined,
} from "@ant-design/icons";
import { artifactContentUrl } from "../../lib/agenthub-api";
import { parseMarkdownBlocks, type MarkdownBlock } from "../../lib/workbench/markdown";

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
  onOpenArtifact,
}: {
  parts?: HubMessagePartDto[];
  fallbackText: string;
  onPinPart?: (part: HubMessagePartDto) => void;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  if (!parts?.length) return <RichText text={fallbackText} />;
  return (
    <div className="richText">
      {parts.flatMap((part, index) => renderMessagePart(part, index, onPinPart, onOpenArtifact))}
    </div>
  );
}

function renderMessagePart(
  part: HubMessagePartDto,
  index: number,
  onPinPart?: (part: HubMessagePartDto) => void,
  onOpenArtifact?: (artifactId: string) => void,
): React.ReactNode[] {
  if (part.type === "code") {
    return [
      <CodeBlock
        key={part.id || index}
        text={part.text ?? ""}
        language={part.language}
        pinned={part.pinned}
        onPin={onPinPart ? () => onPinPart(part) : undefined}
      />,
    ];
  }
  if (part.type === "deploy_status") {
    return [<DeployStatusPart key={part.id || index} part={part} onPinPart={onPinPart} />];
  }
  if (part.type === "link_preview") {
    return [<LinkPreviewPart key={part.id || index} part={part} onPinPart={onPinPart} />];
  }
  if (part.type === "image") {
    return [<ImagePart key={part.id || index} part={part} onPinPart={onPinPart} />];
  }
  if (part.type === "file") {
    return [<FilePart key={part.id || index} part={part} onPinPart={onPinPart} />];
  }
  if (part.type === "artifact") {
    return [<ArtifactPart key={part.id || index} part={part} onPinPart={onPinPart} onOpenArtifact={onOpenArtifact} />];
  }
  if (part.type !== "text") {
    return [
      <div className="messageCardPart" key={part.id || index}>
        <div>
          <strong>{part.title ?? part.type}</strong>
          {onPinPart && (
            <button type="button" title={part.pinned ? "取消 Pin 这个 part" : "Pin 这个 part"} onClick={() => onPinPart(part)}>
              {part.pinned ? <PushpinFilled /> : <PushpinOutlined />}
            </button>
          )}
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

function FilePart({
  part,
  onPinPart,
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
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
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
}) {
  return (
    <div className="imageMessagePart">
      <div className="imageMessageTop">
        <strong>{part.title ?? "图片附件"}</strong>
        <div>
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

function ArtifactPart({
  part,
  onPinPart,
  onOpenArtifact,
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const artifactId = stringMetadata(part.metadata, "artifactId");
  const kind = stringMetadata(part.metadata, "kind") ?? "artifact";
  const mimeType = stringMetadata(part.metadata, "mimeType") ?? "application/octet-stream";
  const version = numberMetadata(part.metadata, "version");
  const final = booleanMetadata(part.metadata, "final");
  const contentUrl = artifactId ? artifactContentUrl(artifactId) : part.url;
  const title = part.title ?? "Artifact";
  const canExpand = Boolean(artifactId && onOpenArtifact);
  const openArtifact = () => {
    if (artifactId && onOpenArtifact) onOpenArtifact(artifactId);
  };
  return (
    <div
      className={`artifactMessagePart ${kind} ${canExpand ? "clickable" : ""}`}
      role={canExpand ? "button" : undefined}
      tabIndex={canExpand ? 0 : undefined}
      onClick={canExpand ? openArtifact : undefined}
      onKeyDown={
        canExpand
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              openArtifact();
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
            <button type="button" title="展开预览" onClick={openArtifact}>
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
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
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
      {onPinPart && (
        <button type="button" title={part.pinned ? "取消 Pin 网页预览" : "Pin 网页预览"} onClick={() => onPinPart(part)}>
          {part.pinned ? <PushpinFilled /> : <PushpinOutlined />}
        </button>
      )}
    </div>
  );
}

function DeployStatusPart({
  part,
  onPinPart,
}: {
  part: HubMessagePartDto;
  onPinPart?: (part: HubMessagePartDto) => void;
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
      {onPinPart && (
        <button type="button" title={part.pinned ? "取消 Pin 部署状态" : "Pin 部署状态"} onClick={() => onPinPart(part)}>
          {part.pinned ? <PushpinFilled /> : <PushpinOutlined />}
        </button>
      )}
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
}: {
  text: string;
  language?: string;
  pinned?: boolean;
  onPin?: () => void;
}) {
  return (
    <div className="codeBlock">
      <div className="codeBlockHeader">
        <span>{language || "code"}</span>
        <div>
          {onPin && (
            <button type="button" title={pinned ? "取消 Pin 这段代码" : "Pin 这段代码"} onClick={onPin}>
              {pinned ? <PushpinFilled /> : <PushpinOutlined />}
            </button>
          )}
          <button type="button" title="复制代码" onClick={() => copyText(text)}>
            <CopyOutlined />
          </button>
        </div>
      </div>
      <pre>{text}</pre>
    </div>
  );
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
