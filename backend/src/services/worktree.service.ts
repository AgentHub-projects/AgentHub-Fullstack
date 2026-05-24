import { Injectable } from "@nestjs/common";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { TestSyncResultDto } from "@agenthub/shared";

const execFileAsync = promisify(execFile);

const EBUSY_RETRY_MS = [100, 250, 500];
const EBUSY_MAX_ATTEMPTS = EBUSY_RETRY_MS.length + 1;

async function rmRetry(target: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
  for (let attempt = 0; attempt < EBUSY_MAX_ATTEMPTS; attempt++) {
    try {
      await rm(target, { ...options });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EBUSY" && attempt < EBUSY_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, EBUSY_RETRY_MS[attempt]));
        continue;
      }
      throw err;
    }
  }
}

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
    await this.cleanupLegacyRepoWorktrees(repoPath);

    const shortRun = runId.replace(/^run-/, "run-");
    const suffix = randomBytes(3).toString("hex");
    const uniqueRun = `${shortRun}-${suffix}`;
    const branchName = `agent/${uniqueRun}/main`;
    const runRoot = process.env.AGENTHUB_WORKTREE_ROOT
      ? join(process.env.AGENTHUB_WORKTREE_ROOT, "runs", uniqueRun)
      : join(tmpdir(), "agenthub", "runs", uniqueRun);
    const worktreesRoot = join(runRoot, "worktrees");
    const worktreePath = join(worktreesRoot, `${uniqueRun}-main`);
    const artifactDir = join(runRoot, "artifacts");

    await mkdir(worktreesRoot, { recursive: true });

    // Try to remove stale worktree, tolerate EBUSY on Windows
    try {
      await this.removeStaleWorktree(repoPath, worktreesRoot, worktreePath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EBUSY") {
        // Silently skip — fresh directory with unique suffix won't conflict
      } else {
        throw err;
      }
    }

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
      await this.cleanupLegacyRepoWorktrees(prepared.repoPath);
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

  private async cleanupLegacyRepoWorktrees(repoPath: string): Promise<void> {
    const repoRoot = resolve(repoPath);
    const target = resolve(repoRoot, ".agenthub", "worktrees");
    const relativeTarget = relative(repoRoot, target);
    if (relativeTarget !== join(".agenthub", "worktrees") || isAbsolute(relativeTarget)) {
      throw new Error(`Refusing to remove legacy worktrees outside ${repoRoot}: ${target}`);
    }

    await rmRetry(target, { recursive: true, force: true });
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
      await rmRetry(worktreePath, { recursive: true, force: true });
      await this.git(repoPath, ["worktree", "prune"]);
    }
  }

  private async cleanupRunWorktree(prepared: PreparedWorktree): Promise<void> {
    try {
      await this.git(prepared.repoPath, ["worktree", "remove", "--force", prepared.worktreePath]);
    } catch {
      await rmRetry(prepared.worktreePath, { recursive: true, force: true });
    } finally {
      await this.git(prepared.repoPath, ["worktree", "prune"]);
      const runDir = dirname(prepared.worktreePath);
      try {
        await rmRetry(runDir, { recursive: true, force: true });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EBUSY") {
          // Windows may still hold handles briefly — tasks can accumulate but won't collide
          // since each run uses a unique suffix via randomBytes
        } else {
          throw err;
        }
      }
    }
  }
}
