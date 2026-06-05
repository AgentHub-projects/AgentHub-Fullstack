import { describe, expect, it } from "vitest";
import { buildTextEdits, sortFilesystemEntries } from "./filesystem";

describe("buildTextEdits", () => {
  it("creates a minimal replacement edit", () => {
    expect(buildTextEdits("one\ntwo\nthree\n", "one\nTWO\nthree\n")).toEqual([
      {
        startLine: 2,
        startColumn: 1,
        endLine: 2,
        endColumn: 4,
        text: "TWO",
      },
    ]);
  });

  it("returns no edits when content is unchanged", () => {
    expect(buildTextEdits("same", "same")).toEqual([]);
  });
});

describe("sortFilesystemEntries", () => {
  it("sorts directories before files", () => {
    expect(sortFilesystemEntries([
      { path: "b.ts", name: "b.ts", kind: "file" },
      { path: "src", name: "src", kind: "dir" },
      { path: "a.ts", name: "a.ts", kind: "file" },
    ])).toEqual([
      { path: "src", name: "src", kind: "dir" },
      { path: "a.ts", name: "a.ts", kind: "file" },
      { path: "b.ts", name: "b.ts", kind: "file" },
    ]);
  });
});
