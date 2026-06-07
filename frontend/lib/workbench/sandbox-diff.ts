import type {
  FilesystemChangedEventDto,
  FilesystemEntryDto,
  FilesystemReadFileDto,
  HubFileChangeDto,
} from "@agenthub/shared";
import { normalizePath } from "./diff";
import { languageFromPath } from "../utils";

export const SANDBOX_DIFF_SOURCE = "sandbox_observed";
export const FILESYSTEM_DRAFT_SOURCE = "filesystem_draft";
export const SANDBOX_BASELINE_DEPTH = 5;
export const SANDBOX_BASELINE_MAX_FILES = 120;
export const SANDBOX_BASELINE_MAX_FILE_SIZE = 256 * 1024;

export type SandboxBaselineStatus = "idle" | "connecting" | "baselining" | "ready" | "unavailable" | "error";

export interface SandboxDiffSessionState {
  status: SandboxBaselineStatus;
  fileCount: number;
  error?: string;
  updatedAt?: string;
}

export interface SandboxFileSnapshot {
  path: string;
  content: string;
  version?: string | null;
  mtime?: string | null;
  size?: number | null;
  language?: string | null;
}

const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

const TEXT_EXTENSIONS = new Set([
  "c",
  "cc",
  "cfg",
  "cjs",
  "cpp",
  "cs",
  "css",
  "csv",
  "go",
  "graphql",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "less",
  "log",
  "md",
  "mdx",
  "mjs",
  "php",
  "prisma",
  "properties",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

const TEXT_FILENAMES = new Set([
  ".env",
  ".env.example",
  ".gitignore",
  ".npmrc",
  "Dockerfile",
  "Makefile",
  "README",
]);

export function shouldTrackSandboxEntry(entry: FilesystemEntryDto) {
  return entry.kind === "file" && shouldTrackSandboxPath(entry.path, entry.size);
}

export function shouldTrackSandboxPath(path: string, size?: number | null) {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => IGNORED_PATH_SEGMENTS.has(part))) return false;
  if (typeof size === "number" && size > SANDBOX_BASELINE_MAX_FILE_SIZE) return false;

  const fileName = parts.at(-1) ?? normalized;
  if (TEXT_FILENAMES.has(fileName)) return true;
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : "";
  return Boolean(ext && TEXT_EXTENSIONS.has(ext));
}

export function snapshotFromReadFile(file: FilesystemReadFileDto): SandboxFileSnapshot {
  return {
    path: normalizePath(file.path),
    content: file.content,
    version: file.version,
    mtime: file.mtime,
    size: file.size,
    language: languageFromPath(file.path),
  };
}

export function makeSandboxObservedChange(input: {
  sessionId: string;
  runId?: string | null;
  event: FilesystemChangedEventDto;
  baseline?: SandboxFileSnapshot | null;
  current?: SandboxFileSnapshot | null;
  occurredAt?: string;
}): HubFileChangeDto | null {
  const path = normalizePath(input.event.path);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const removed = input.event.changeType === "remove";
  const hasBaseline = Boolean(input.baseline);
  const current = input.current ?? null;

  if (!removed && input.baseline && current && input.baseline.content === current.content) return null;

  return {
    id: `sandbox-${input.sessionId}-${stablePathId(path)}`,
    sessionId: input.sessionId,
    runId: input.runId ?? "",
    path,
    changeType: sandboxChangeType(input.event.changeType, hasBaseline),
    language: current?.language ?? input.baseline?.language ?? languageFromPath(path),
    beforeContent: input.baseline?.content ?? null,
    beforeSha256: input.baseline?.version ?? null,
    beforeTruncated: false,
    afterContent: removed ? null : current?.content ?? null,
    afterSha256: removed ? null : current?.version ?? input.event.version ?? null,
    afterTruncated: false,
    patch: null,
    stats: {},
    metadata: {
      source: SANDBOX_DIFF_SOURCE,
      actor: input.event.actor ?? null,
      eventChangeType: input.event.changeType,
      baselineAvailable: hasBaseline,
      baselineVersion: input.baseline?.version ?? null,
      currentVersion: removed ? null : current?.version ?? input.event.version ?? null,
      observedAt: occurredAt,
    },
    createdAt: occurredAt,
  };
}

export function makeFilesystemDraftChange(input: {
  sessionId: string;
  path: string;
  beforeContent: string;
  afterContent: string;
  language?: string | null;
  occurredAt?: string;
}): HubFileChangeDto | null {
  if (input.beforeContent === input.afterContent) return null;
  const path = normalizePath(input.path);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  return {
    id: `draft-${input.sessionId}-${stablePathId(path)}`,
    sessionId: input.sessionId,
    runId: "",
    path,
    changeType: "modified",
    language: input.language ?? languageFromPath(path),
    beforeContent: input.beforeContent,
    beforeTruncated: false,
    afterContent: input.afterContent,
    afterTruncated: false,
    patch: null,
    stats: {},
    metadata: {
      source: FILESYSTEM_DRAFT_SOURCE,
      baselineAvailable: true,
    },
    createdAt: occurredAt,
  };
}

export function upsertObservedChange(changes: HubFileChangeDto[], nextChange: HubFileChangeDto) {
  return [nextChange, ...changes.filter((change) => change.id !== nextChange.id)].sort((a, b) =>
    normalizePath(a.path).localeCompare(normalizePath(b.path)),
  );
}

export function removeObservedChange(changes: HubFileChangeDto[], path: string) {
  const normalized = normalizePath(path);
  return changes.filter((change) => normalizePath(change.path) !== normalized);
}

export function isSandboxObservedChange(change: HubFileChangeDto) {
  return change.metadata?.source === SANDBOX_DIFF_SOURCE;
}

export function isFilesystemDraftChange(change: HubFileChangeDto) {
  return change.metadata?.source === FILESYSTEM_DRAFT_SOURCE;
}

export function hasSandboxBaseline(change: HubFileChangeDto) {
  return change.metadata?.baselineAvailable !== false;
}

export function sandboxDiffLabel(change: HubFileChangeDto) {
  if (isFilesystemDraftChange(change)) return "未保存草稿";
  if (isSandboxObservedChange(change)) return hasSandboxBaseline(change) ? "沙箱变更" : "缺少基线";
  return "后端变更";
}

function sandboxChangeType(changeType: string, hasBaseline: boolean): HubFileChangeDto["changeType"] {
  if (changeType === "create") return "added";
  if (changeType === "remove") return "deleted";
  if (changeType === "rename") return "renamed";
  return hasBaseline ? "modified" : "added";
}


function stablePathId(path: string) {
  return normalizePath(path).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}
