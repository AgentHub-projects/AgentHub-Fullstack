import { Injectable } from "@nestjs/common";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { TestSyncResultDto } from "@agenthub/shared";

const execFileAsync = promisify(execFile);

export interface PreparedWorktree {
  repoPath: string;
  branchName: string;
  worktreePath: string;
  summaryPath: string;
  logPath: string;
}

@Injectable()
export class WorktreeService {
  async prepare(runId: string, requestedRepoPath?: string): Promise<PreparedWorktree> {
    const repoPath = requestedRepoPath ?? process.env.AGENTHUB_TEST_REPO_PATH ?? "D:\\agent\\AgentHub-Test";
    await this.git(repoPath, ["rev-parse", "--is-inside-work-tree"]);

    const shortRun = runId.replace(/^run-/, "run-");
    const branchName = `agent/${shortRun}/main`;
    const runRoot = join(tmpdir(), "agenthub", "runs", shortRun);
    const worktreesRoot = join(runRoot, "worktrees");
    const worktreePath = join(worktreesRoot, `${shortRun}-main`);
    const artifactDir = join(runRoot, "artifacts");

    await mkdir(worktreesRoot, { recursive: true });
    await this.removeStaleWorktree(repoPath, worktreesRoot, worktreePath);
    await this.git(repoPath, ["worktree", "add", "-B", branchName, worktreePath, "main"]);
    await mkdir(artifactDir, { recursive: true });

    return {
      repoPath,
      branchName,
      worktreePath,
      summaryPath: join(artifactDir, "summary.md"),
      logPath: join(artifactDir, "agent.log")
    };
  }

  async appendLog(prepared: PreparedWorktree, text: string): Promise<void> {
    await mkdir(dirname(prepared.logPath), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(prepared.logPath, "utf8");
    } catch {
      existing = "";
    }
    await writeFile(prepared.logPath, `${existing}${text}`, "utf8");
  }

  async complete(prepared: PreparedWorktree, summary: string): Promise<TestSyncResultDto> {
    try {
      await mkdir(dirname(prepared.summaryPath), { recursive: true });
      await writeFile(prepared.summaryPath, summary, "utf8");

      await this.stageTargetChanges(prepared.worktreePath);
      const hasChanges = (await this.git(prepared.worktreePath, ["diff", "--cached", "--name-only"])).stdout
        .trim()
        .length > 0;
      let commitSha: string | undefined;

      if (hasChanges) {
        await this.git(prepared.worktreePath, ["commit", "-m", `agenthub ${prepared.branchName}`]);
        commitSha = (await this.git(prepared.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
      } else {
        commitSha = (await this.git(prepared.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
      }

      await this.git(prepared.repoPath, ["checkout", "main"]);
      await this.git(prepared.repoPath, ["merge", "--no-ff", prepared.branchName, "-m", `merge ${prepared.branchName}`]);
      await this.cleanupRunWorktree(prepared);

      return {
        status: "synced",
        targetBranch: "main",
        commitSha,
        summaryPath: prepared.summaryPath
      };
    } catch (error) {
      try {
        await this.cleanupRunWorktree(prepared);
      } catch {
        // Keep the original sync error so callers report TEST_SYNC_FAILED for the real failure.
      }
      return this.fail(error);
    }
  }

  async fail(error: unknown): Promise<TestSyncResultDto> {
    return {
      status: "failed",
      targetBranch: "main",
      error: {
        code: "TEST_SYNC_FAILED",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }

  private async git(cwd: string, args: string[]) {
    return execFileAsync("git", args, { cwd });
  }

  private async stageTargetChanges(worktreePath: string): Promise<void> {
    await this.git(worktreePath, ["add", "-A", "--", ".", ":(exclude).agenthub"]);

    const deletedAgentHubFiles = (await this.git(worktreePath, ["ls-files", "--deleted", "--", ".agenthub"])).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (deletedAgentHubFiles.length > 0) {
      await this.git(worktreePath, ["rm", "--quiet", "--ignore-unmatch", "--", ...deletedAgentHubFiles]);
    }
  }

  private async removeStaleWorktree(repoPath: string, worktreesRoot: string, worktreePath: string): Promise<void> {
    const root = resolve(worktreesRoot);
    const target = resolve(worktreePath);
    const relativeTarget = relative(root, target);
    if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
      throw new Error(`Refusing to remove worktree outside ${worktreesRoot}: ${worktreePath}`);
    }

    try {
      await this.git(repoPath, ["worktree", "remove", "--force", worktreePath]);
      await this.git(repoPath, ["worktree", "prune"]);
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
      await this.git(repoPath, ["worktree", "prune"]);
    }
  }

  private async cleanupRunWorktree(prepared: PreparedWorktree): Promise<void> {
    try {
      await this.git(prepared.repoPath, ["worktree", "remove", "--force", prepared.worktreePath]);
    } catch {
      await rm(prepared.worktreePath, { recursive: true, force: true });
    } finally {
      await this.git(prepared.repoPath, ["worktree", "prune"]);
      await rm(dirname(prepared.worktreePath), { recursive: true, force: true });
    }
  }
}
