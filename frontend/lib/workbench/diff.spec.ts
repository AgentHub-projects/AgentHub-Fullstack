import { describe, expect, it } from "vitest";
import type { HubFileChangeDto } from "@agenthub/shared";
import { buildDiffLines, countChangeLines } from "./diff";

describe("buildDiffLines", () => {
  it("builds a before/after text diff", () => {
    const lines = buildDiffLines(changeFixture({
      beforeContent: "one\ntwo\nthree\n",
      afterContent: "one\nTWO\nthree\n",
    }));

    expect(lines.map((line) => line.kind)).toEqual(["context", "add", "remove", "context"]);
    expect(countChangeLines(changeFixture({ beforeContent: "a", afterContent: "b" }), "add")).toBe(1);
    expect(countChangeLines(changeFixture({ beforeContent: "a", afterContent: "b" }), "remove")).toBe(1);
  });

  it("treats added and deleted files as reliable diffs when content is present", () => {
    expect(buildDiffLines(changeFixture({ changeType: "added", afterContent: "new\nfile" }))).toMatchObject([
      { kind: "add", newLine: 1, text: "new" },
      { kind: "add", newLine: 2, text: "file" },
    ]);
    expect(buildDiffLines(changeFixture({ changeType: "deleted", beforeContent: "old\nfile" }))).toMatchObject([
      { kind: "remove", oldLine: 1, text: "old" },
      { kind: "remove", oldLine: 2, text: "file" },
    ]);
  });

  it("falls back to full remove/add for large comparisons", () => {
    const beforeContent = Array.from({ length: 151 }, (_, index) => `old-${index}`).join("\n");
    const afterContent = Array.from({ length: 151 }, (_, index) => `new-${index}`).join("\n");
    const lines = buildDiffLines(changeFixture({ beforeContent, afterContent }));

    expect(lines.filter((line) => line.kind === "remove")).toHaveLength(151);
    expect(lines.filter((line) => line.kind === "add")).toHaveLength(151);
  });

  it("does not invent additions when sandbox baseline is missing", () => {
    const change = changeFixture({
      afterContent: "current only",
      metadata: { baselineAvailable: false },
    });

    expect(buildDiffLines(change)).toEqual([{ kind: "context", newLine: 1, text: "current only" }]);
    expect(countChangeLines(change, "add")).toBe(0);
    expect(countChangeLines(change, "remove")).toBe(0);
  });
});

function changeFixture(overrides: Partial<HubFileChangeDto> = {}): HubFileChangeDto {
  return {
    id: "change-1",
    sessionId: "session-1",
    runId: "run-1",
    artifactId: null,
    producingEventId: null,
    path: "src/App.tsx",
    oldPath: null,
    changeType: "modified",
    language: "tsx",
    beforeContent: null,
    beforeSha256: null,
    beforeTruncated: false,
    afterContent: null,
    afterSha256: null,
    afterTruncated: false,
    patch: null,
    stats: {},
    metadata: {},
    createdAt: "2026-06-05T00:00:00.000Z",
    ...overrides,
  };
}
