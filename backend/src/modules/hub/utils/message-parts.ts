import type { HubMessagePartDto } from "@agenthub/shared";

/** 解析消息文本，按代码块和普通文本拆分为消息部件数组 */
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

/** 从文本中提取 URL 并抓取 Open Graph 元数据，生成链接预览部件（最多 5 个） */
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

/** 合并解析后的文本部件、payload 部件和额外部件，生成完整的 contentJson */
export function messageJsonWithParts(
  base: Record<string, unknown>,
  contentText: string,
  extraParts: HubMessagePartDto[] = [],
) {
  const payloadParts = Array.isArray(base.parts)
    ? base.parts.map(normalizePayloadPart).filter((part): part is HubMessagePartDto => Boolean(part))
    : [];
  return {
    ...base,
    parts: [...parseMessageParts(contentText), ...payloadParts, ...extraParts],
  };
}

/** 标准化 payload 中的单个部件 */
function normalizePayloadPart(value: unknown, index: number): HubMessagePartDto | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const type = typeof raw.type === "string" && raw.type.trim() ? raw.type.trim() : "";
  if (!type) return null;
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `payload_${index + 1}`,
    type,
    ...(typeof raw.text === "string" ? { text: raw.text } : {}),
    ...(typeof raw.language === "string" ? { language: raw.language } : {}),
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    ...(typeof raw.pinned === "boolean" ? { pinned: raw.pinned } : {}),
    ...(raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? { metadata: raw.metadata as Record<string, unknown> }
      : {}),
  };
}

/** 创建文本类型部件 */
function textPart(index: number, text: string): HubMessagePartDto {
  return {
    id: `part_${index + 1}`,
    type: "text",
    text,
  };
}

/** 抓取网页的 Open Graph 标题和描述，3 秒超时 */
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

/** 从 HTML 中提取 Open Graph meta 标签的 content 值 */
function ogValue(html: string, property: string) {
  const pattern = new RegExp(`<meta[^>]+property=["']${escapeRegExp(property)}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i");
  return decodeHtml(pattern.exec(html)?.[1]);
}

/** 从 HTML 中提取 name 属性 meta 标签的 content 值 */
function metaNameValue(html: string, name: string) {
  const pattern = new RegExp(`<meta[^>]+name=["']${escapeRegExp(name)}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i");
  return decodeHtml(pattern.exec(html)?.[1]);
}

/** 从 HTML 中提取指定标签的文本内容 */
function tagValue(html: string, tag: string) {
  const pattern = new RegExp(`<${escapeRegExp(tag)}[^>]*>([^<]*)</${escapeRegExp(tag)}>`, "i");
  return decodeHtml(pattern.exec(html)?.[1]);
}

/** 解码 HTML 实体（&amp; &lt; &gt; &quot; &#39;） */
function decodeHtml(value: string | undefined) {
  return value
    ?.replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** 转义正则表达式特殊字符 */
function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
