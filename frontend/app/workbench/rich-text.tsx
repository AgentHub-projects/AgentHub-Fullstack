import type React from "react";
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

function renderMarkdownBlock(block: MarkdownBlock, index: number): React.ReactNode {
  if (block.kind === "heading") {
    const Tag = block.level <= 1 ? "h2" : "h3";
    return <Tag key={index}>{block.text}</Tag>;
  }
  if (block.kind === "code") {
    return (
      <div className="codeBlock" key={index}>
        {block.language && <span>{block.language}</span>}
        <pre>{block.text}</pre>
      </div>
    );
  }
  if (block.kind === "ul") {
    return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>;
  }
  if (block.kind === "ol") {
    return <ol key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ol>;
  }
  if (block.kind === "quote") {
    return <blockquote key={index}>{block.text}</blockquote>;
  }
  if (block.kind === "table") {
    return (
      <div className="markdownTableWrap" key={index}>
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
  return <p key={index}>{block.text}</p>;
}
