import type { HubFileChangeDto } from "@agenthub/shared";
import type { DiffLine, DiffLineKind, FileTreeRow } from "./types";

export function buildFileTreeRows(changes: HubFileChangeDto[]): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const seenFolders = new Set<string>();
  const sorted = [...changes].sort((a, b) => normalizePath(a.path).localeCompare(normalizePath(b.path)));

  for (const change of sorted) {
    const parts = normalizePath(change.path).split("/").filter(Boolean);
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const key = parts.slice(0, depth + 1).join("/");
      if (!seenFolders.has(key)) {
        seenFolders.add(key);
        rows.push({ key, depth, label: parts[depth], kind: "folder" });
      }
    }
    rows.push({
      key: change.id,
      depth: Math.max(0, parts.length - 1),
      label: parts.at(-1) ?? change.path,
      kind: "file",
      change,
    });
  }

  return rows;
}

export function buildDiffLines(change: HubFileChangeDto): DiffLine[] {
  if (change.patch?.trim()) return parseUnifiedPatch(change.patch);
  return diffText(change.beforeContent ?? "", change.afterContent ?? "");
}

export function parseUnifiedPatch(patch: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      result.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff --git") || raw.startsWith("index ")) {
      result.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      result.push({ kind: "add", newLine: newLine++, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("-")) {
      result.push({ kind: "remove", oldLine: oldLine++, text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("\\")) {
      result.push({ kind: "meta", text: raw });
      continue;
    }
    result.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }

  return result;
}

export function countChangeLines(change: HubFileChangeDto, kind: "add" | "remove") {
  const value = change.stats[kind === "add" ? "additions" : "deletions"];
  if (typeof value === "number") return value;
  return buildDiffLines(change).filter((line) => line.kind === kind).length;
}

export function diffMarker(kind: DiffLineKind) {
  if (kind === "add") return "+";
  if (kind === "remove") return "-";
  if (kind === "meta") return "";
  return " ";
}

export function normalizePath(path: string) {
  return path.replace(/\\/g, "/");
}

function diffText(before: string, after: string): DiffLine[] {
  const beforeLines = splitLinesForDiff(before);
  const afterLines = splitLinesForDiff(after);
  if (beforeLines.length === 0 && afterLines.length === 0) return [{ kind: "context", text: "" }];
  if (beforeLines.length * afterLines.length > 20000) {
    return [
      ...beforeLines.map((text, index) => ({ kind: "remove" as const, oldLine: index + 1, text })),
      ...afterLines.map((text, index) => ({ kind: "add" as const, newLine: index + 1, text })),
    ];
  }

  const matrix = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0) as number[]);
  for (let i = beforeLines.length - 1; i >= 0; i--) {
    for (let j = afterLines.length - 1; j >= 0; j--) {
      matrix[i][j] = beforeLines[i] === afterLines[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < beforeLines.length || newIndex < afterLines.length) {
    if (oldIndex < beforeLines.length && newIndex < afterLines.length && beforeLines[oldIndex] === afterLines[newIndex]) {
      lines.push({ kind: "context", oldLine: oldIndex + 1, newLine: newIndex + 1, text: beforeLines[oldIndex] });
      oldIndex++;
      newIndex++;
    } else if (newIndex < afterLines.length && (oldIndex === beforeLines.length || matrix[oldIndex][newIndex + 1] >= matrix[oldIndex + 1][newIndex])) {
      lines.push({ kind: "add", newLine: newIndex + 1, text: afterLines[newIndex] });
      newIndex++;
    } else if (oldIndex < beforeLines.length) {
      lines.push({ kind: "remove", oldLine: oldIndex + 1, text: beforeLines[oldIndex] });
      oldIndex++;
    }
  }
  return lines;
}

function splitLinesForDiff(text: string) {
  if (!text) return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}
