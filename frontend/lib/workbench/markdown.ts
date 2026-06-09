export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "hr" };

export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "image"; alt: string; url: string }
  | { kind: "strikethrough"; text: string };

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index++;
      }
      if (index < lines.length) index++;
      blocks.push({ kind: "code", language: fence[1] ?? "", text: code.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      index++;
      continue;
    }

    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith(">")) {
        quote.push(lines[index].replace(/^>\s?/, ""));
        index++;
      }
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index++;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      index++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !/^(#{1,4})\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !lines[index].startsWith(">") &&
      !isTableStart(lines, index) &&
      !/^[-*_]{3,}\s*$/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index++;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

function isTableStart(lines: string[], index: number) {
  return Boolean(
    lines[index]?.includes("|") &&
      lines[index + 1] &&
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]),
  );
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const INLINE_TOKEN = /(`[^`]*`|!\[.*?\]\(.*?\)|\[.*?\]\(.*?\)|\*\*|~~|\*)/;
const LINK_IMAGE_RE = /^!?\[(.*?)\]\((.*?)\)$/;
const CODE_RE = /^`([^`]*)`$/;

export function parseInlineMarkdown(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const match = remaining.match(INLINE_TOKEN);
    if (!match || match.index === undefined) {
      pushText(remaining);
      break;
    }

    if (match.index > 0) {
      pushText(remaining.slice(0, match.index));
    }

    const token = match[0];
    const after = remaining.slice(match.index + token.length);

    if (token.startsWith("`")) {
      const m = token.match(CODE_RE);
      segments.push({ kind: "code", text: m ? m[1] : "" });
    } else if (token === "**") {
      const closing = after.indexOf("**");
      if (closing >= 0) {
        segments.push({ kind: "bold", text: after.slice(0, closing) });
        remaining = after.slice(closing + 2);
        continue;
      }
      pushText(token);
    } else if (token === "*") {
      if (after.startsWith("*")) {
        pushText("*");
        remaining = after;
        continue;
      }
      const closing = after.indexOf("*");
      if (closing >= 0) {
        segments.push({ kind: "italic", text: after.slice(0, closing) });
        remaining = after.slice(closing + 1);
        continue;
      }
      pushText(token);
    } else if (token === "~~") {
      const closing = after.indexOf("~~");
      if (closing >= 0) {
        segments.push({ kind: "strikethrough", text: after.slice(0, closing) });
        remaining = after.slice(closing + 2);
        continue;
      }
      pushText(token);
    } else if (token.startsWith("!") || token.startsWith("[")) {
      const m = token.match(LINK_IMAGE_RE);
      if (m) {
        if (token.startsWith("!")) {
          segments.push({ kind: "image", alt: m[1], url: m[2] });
        } else {
          if (isImageUrl(m[2])) {
            segments.push({ kind: "image", alt: m[1] || "", url: m[2] });
          } else {
            segments.push({ kind: "link", text: m[1] || m[2], url: m[2] });
          }
        }
      } else {
        pushText(token);
      }
    } else {
      pushText(token);
    }

    remaining = after;
  }

  return segments;

  function pushText(t: string) {
    if (!t) return;
    const last = segments[segments.length - 1];
    if (last?.kind === "text") {
      last.text += t;
    } else {
      segments.push({ kind: "text", text: t });
    }
  }
}

function isImageUrl(url: string) {
  const lower = new URL(url, "https://placeholder").pathname.toLowerCase();
  return /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)([?#]|$)/.test(lower);
}
