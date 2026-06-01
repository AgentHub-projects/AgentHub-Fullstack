import type { HubMessagePartDto } from "@agenthub/shared";

export function parseMessageParts(contentText: string): HubMessagePartDto[] {
  const parts: HubMessagePartDto[] = [];
  const codeFence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeFence.exec(contentText)) !== null) {
    const before = contentText.slice(lastIndex, match.index);
    if (before) parts.push(textPart(parts.length, before));

    const language = match[1]?.trim();
    parts.push({
      id: `part_${parts.length + 1}`,
      type: "code",
      text: match[2] ?? "",
      language: language || undefined,
    });
    lastIndex = match.index + match[0].length;
  }

  const rest = contentText.slice(lastIndex);
  if (rest) parts.push(textPart(parts.length, rest));
  return parts.length ? parts : [textPart(0, contentText)];
}

export async function buildLinkPreviewParts(contentText: string): Promise<HubMessagePartDto[]> {
  const urls = [...new Set(contentText.match(/https?:\/\/[^\s<>)"']+/g) ?? [])].slice(0, 5);
  const parts: HubMessagePartDto[] = [];
  for (const url of urls) {
    const preview = await fetchOpenGraph(url);
    parts.push({
      id: `link_${parts.length + 1}`,
      type: "link_preview",
      title: preview.title || url,
      url,
      metadata: {
        description: preview.description,
      },
    });
  }
  return parts;
}

export function messageJsonWithParts(
  base: Record<string, unknown>,
  contentText: string,
  extraParts: HubMessagePartDto[] = [],
) {
  return {
    ...base,
    parts: [...parseMessageParts(contentText), ...extraParts],
  };
}

function textPart(index: number, text: string): HubMessagePartDto {
  return {
    id: `part_${index + 1}`,
    type: "text",
    text,
  };
}

async function fetchOpenGraph(url: string): Promise<{ title?: string; description?: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const html = await response.text();
    return {
      title: ogValue(html, "og:title") ?? tagValue(html, "title"),
      description: ogValue(html, "og:description") ?? metaNameValue(html, "description"),
    };
  } catch {
    return {};
  }
}

function ogValue(html: string, property: string) {
  const pattern = new RegExp(`<meta[^>]+property=["']${escapeRegExp(property)}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i");
  return decodeHtml(pattern.exec(html)?.[1]);
}

function metaNameValue(html: string, name: string) {
  const pattern = new RegExp(`<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i");
  return decodeHtml(pattern.exec(html)?.[1]);
}

function tagValue(html: string, tag: string) {
  const pattern = new RegExp(`<${escapeRegExp(tag)}[^>]*>([^<]*)</${escapeRegExp(tag)}>`, "i");
  return decodeHtml(pattern.exec(html)?.[1]);
}

function decodeHtml(value: string | undefined) {
  return value
    ?.replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
