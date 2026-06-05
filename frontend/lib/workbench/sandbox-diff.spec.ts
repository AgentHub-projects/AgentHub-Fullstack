import { describe, expect, it } from "vitest";
import type { HubFileChangeDto } from "@agenthub/shared";
import {
  makeFilesystemDraftChange,
  makeSandboxObservedChange,
  removeObservedChange,
  shouldTrackSandboxPath,
  snapshotFromReadFile,
  upsertObservedChange,
} from "./sandbox-diff";

describe("sandbox diff helpers", () => {
  it("creates a reliable change when a baseline exists", () => {
    const baseline = snapshot("src/App.tsx", "old");
    const current = snapshot("src/App.tsx", "new", "v2");
    const change = makeSandboxObservedChange({
      sessionId: "session-1",
      runId: "run-1",
      event: { path: "src/App.tsx", changeType: "write", version: "v2" },
      baseline,
      current,
      occurredAt: "2026-06-05T00:00:00.000Z",
    });

    expect(change).toMatchObject({
      id: "sandbox-session-1-src-App-tsx",
      changeType: "modified",
      beforeContent: "old",
      afterContent: "new",
      metadata: { baselineAvailable: true, source: "sandbox_observed" },
    });
  });

  it("marks changed files without baseline instead of inventing before content", () => {
    const change = makeSandboxObservedChange({
      sessionId: "session-1",
      event: { path: "src/New.tsx", changeType: "write", version: "v1" },
      current: snapshot("src/New.tsx", "current", "v1"),
      occurredAt: "2026-06-05T00:00:00.000Z",
    });

    expect(change).toMatchObject({
      changeType: "added",
      beforeContent: null,
      afterContent: "current",
      metadata: { baselineAvailable: false },
    });
  });

  it("creates deleted changes only from available baseline content", () => {
    const change = makeSandboxObservedChange({
      sessionId: "session-1",
      event: { path: "src/Old.ts", changeType: "remove" },
      baseline: snapshot("src/Old.ts", "old"),
      occurredAt: "2026-06-05T00:00:00.000Z",
    });

    expect(change).toMatchObject({
      changeType: "deleted",
      beforeContent: "old",
      afterContent: null,
      metadata: { baselineAvailable: true },
    });
  });

  it("deduplicates repeated changed events by path-derived id", () => {
    const first = changeFixture("sandbox-session-1-src-App-tsx", "src/App.tsx", "first");
    const second = changeFixture("sandbox-session-1-src-App-tsx", "src/App.tsx", "second");

    const changes = upsertObservedChange(upsertObservedChange([], first), second);

    expect(changes).toHaveLength(1);
    expect(changes[0].afterContent).toBe("second");
    expect(removeObservedChange(changes, "src/App.tsx")).toEqual([]);
  });

  it("builds draft changes only when the editor content is dirty", () => {
    expect(makeFilesystemDraftChange({
      sessionId: "session-1",
      path: "src/App.tsx",
      beforeContent: "same",
      afterContent: "same",
    })).toBeNull();

    expect(makeFilesystemDraftChange({
      sessionId: "session-1",
      path: "src/App.tsx",
      beforeContent: "old",
      afterContent: "new",
      occurredAt: "2026-06-05T00:00:00.000Z",
    })).toMatchObject({
      id: "draft-session-1-src-App-tsx",
      metadata: { source: "filesystem_draft", baselineAvailable: true },
    });
  });

  it("filters files suitable for text baseline capture", () => {
    expect(shouldTrackSandboxPath("src/App.tsx", 100)).toBe(true);
    expect(shouldTrackSandboxPath("node_modules/pkg/index.js", 100)).toBe(false);
    expect(shouldTrackSandboxPath("src/logo.png", 100)).toBe(false);
    expect(shouldTrackSandboxPath("src/huge.ts", 300 * 1024)).toBe(false);
  });
});

function snapshot(path: string, content: string, version = "v1") {
  return snapshotFromReadFile({
    path,
    content,
    version,
    size: content.length,
    mtime: "2026-06-05T00:00:00.000Z",
  });
}

function changeFixture(id: string, path: string, afterContent: string): HubFileChangeDto {
  return {
    id,
    sessionId: "session-1",
    runId: "",
    path,
    changeType: "modified",
    language: "tsx",
    beforeContent: "old",
    beforeTruncated: false,
    afterContent,
    afterTruncated: false,
    patch: null,
    stats: {},
    metadata: { source: "sandbox_observed" },
    createdAt: "2026-06-05T00:00:00.000Z",
  };
}
