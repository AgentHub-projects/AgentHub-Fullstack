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

export function messageJsonWithParts(base: Record<string, unknown>, contentText: string) {
  return {
    ...base,
    parts: parseMessageParts(contentText),
  };
}

function textPart(index: number, text: string): HubMessagePartDto {
  return {
    id: `part_${index + 1}`,
    type: "text",
    text,
  };
}
