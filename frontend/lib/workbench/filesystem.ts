import type { FilesystemEntryDto, FilesystemTextEditDto } from "@agenthub/shared";

export function buildTextEdits(before: string, after: string): FilesystemTextEditDto[] {
  if (before === after) return [];

  const minLength = Math.min(before.length, after.length);
  let start = 0;
  while (start < minLength && before[start] === after[start]) start += 1;

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const startPosition = offsetToLineColumn(before, start);
  const endPosition = offsetToLineColumn(before, beforeEnd);
  return [{
    startLine: startPosition.line,
    startColumn: startPosition.column,
    endLine: endPosition.line,
    endColumn: endPosition.column,
    text: after.slice(start, afterEnd),
  }];
}

export function sortFilesystemEntries(entries: FilesystemEntryDto[]) {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function offsetToLineColumn(text: string, offset: number) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
