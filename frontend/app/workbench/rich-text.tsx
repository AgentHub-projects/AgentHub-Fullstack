import type React from "react";
import type { HubMessagePartDto } from "@agenthub/shared";
import { CopyOutlined, PushpinFilled, PushpinOutlined } from "@ant-design/icons";
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
}: {
  parts?: HubMessagePartDto[];
  fallbackText: string;
  onPinPart?: (part: HubMessagePartDto) => void;
}) {
  if (!parts?.length) return <RichText text={fallbackText} />;
  return (
    <div className="richText">
      {parts.flatMap((part, index) => renderMessagePart(part, index, onPinPart))}
    </div>
  );
}

function renderMessagePart(
  part: HubMessagePartDto,
  index: number,
  onPinPart?: (part: HubMessagePartDto) => void,
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
