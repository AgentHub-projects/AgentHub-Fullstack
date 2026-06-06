import { describe, expect, it } from "vitest";
import {
  mainGitCommitsPath,
  mainGitDiffFilesPath,
  mainGitFileDiffPath,
} from "./agenthub-api";

describe("main git API paths", () => {
  it("builds commit list URLs with optional pagination", () => {
    expect(mainGitCommitsPath()).toBe("/filesystem/git/main/commits");
    expect(mainGitCommitsPath({ limit: 25, cursor: "abc123" })).toBe(
      "/filesystem/git/main/commits?limit=25&cursor=abc123",
    );
  });

  it("encodes commit SHA and file path for diff URLs", () => {
    expect(mainGitDiffFilesPath("abc/123")).toBe("/filesystem/git/main/commits/abc%2F123/diff/files");
    expect(mainGitFileDiffPath("abc123", "src/pages/a b.tsx")).toBe(
      "/filesystem/git/main/commits/abc123/diff/file?path=src%2Fpages%2Fa+b.tsx",
    );
  });
});
