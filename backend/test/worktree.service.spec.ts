import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeService } from "../src/services/worktree.service";

const execFileAsync = promisify(execFile);

describe("WorktreeService", () => {
  let repoPath: string | undefined;

  afterEach(async () => {
    if (repoPath) {
      await rm(repoPath, { recursive: true, force: true });
      repoPath = undefined;
    }
  });

  it("creates a run worktree, commits artifacts, and merges to main", async () => {
    repoPath = await mkdtemp(join(tmpdir(), "agenthub-test-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: repoPath });
    await writeFile(join(repoPath, "README.md"), "# Test\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });

    const service = new WorktreeService();
    const prepared = await service.prepare("run-900", repoPath);
    await writeFile(join(prepared.worktreePath, "generated.txt"), "hello\n", "utf8");
    const result = await service.complete(prepared, "# Summary\n");

    expect(result.status).toBe("synced");
    expect(result.commitSha).toBeTruthy();
    const generated = await readFile(join(repoPath, "generated.txt"), "utf8");
    const summary = await readFile(join(repoPath, ".agenthub", "artifacts", "run-900", "summary.md"), "utf8");
    expect(generated.replace(/\r\n/g, "\n")).toBe("hello\n");
    expect(summary.replace(/\r\n/g, "\n")).toBe("# Summary\n");
  });
});
