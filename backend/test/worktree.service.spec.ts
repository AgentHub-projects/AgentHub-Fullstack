import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, AgentRun } from "@agenthub/shared";
import { AgentRunner } from "../src/services/agent-runner.service";
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

  it("creates a run worktree, commits only target files, merges to main, and cleans the run worktree", async () => {
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
    await mkdir(join(prepared.worktreePath, ".agenthub"), { recursive: true });
    await writeFile(join(prepared.worktreePath, ".agenthub", "agent.log"), "do not commit\n", "utf8");
    const result = await service.complete(prepared, "# Summary\n");

    expect(result.status).toBe("synced");
    expect(result.commitSha).toBeTruthy();
    const generated = await readFile(join(repoPath, "generated.txt"), "utf8");
    expect(generated.replace(/\r\n/g, "\n")).toBe("hello\n");
    await expect(access(join(repoPath, ".agenthub"))).rejects.toThrow();
    await expect(access(prepared.worktreePath)).rejects.toThrow();
    await expect(readFile(prepared.summaryPath, "utf8")).resolves.toBe("# Summary\n");
  });

  it("stages tracked .agenthub deletions without committing new .agenthub files", async () => {
    repoPath = await mkdtemp(join(tmpdir(), "agenthub-clean-agenthub-"));
    await initRepo(repoPath);
    await mkdir(join(repoPath, ".agenthub"), { recursive: true });
    await writeFile(join(repoPath, ".agenthub", "old.txt"), "old\n", "utf8");
    await execFileAsync("git", ["add", ".agenthub/old.txt"], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "track old agenthub file"], { cwd: repoPath });

    const service = new WorktreeService();
    const prepared = await service.prepare("run-903", repoPath);
    await rm(join(prepared.worktreePath, ".agenthub", "old.txt"), { force: true });
    await writeFile(join(prepared.worktreePath, ".agenthub", "new.txt"), "new\n", "utf8");
    const result = await service.complete(prepared, "# Summary\n");

    expect(result.status).toBe("synced");
    await expect(access(join(repoPath, ".agenthub", "old.txt"))).rejects.toThrow();
    await expect(access(join(repoPath, ".agenthub", "new.txt"))).rejects.toThrow();
    const trackedAgentHubFiles = (await execFileAsync("git", ["ls-files", ".agenthub"], { cwd: repoPath })).stdout
      .trim();
    expect(trackedAgentHubFiles).toBe("");
  });

  it("does not sync generated dependency or build directories back to main", async () => {
    repoPath = await mkdtemp(join(tmpdir(), "agenthub-ignore-generated-"));
    await initRepo(repoPath);

    const service = new WorktreeService();
    const prepared = await service.prepare("run-905", repoPath);
    await mkdir(join(prepared.worktreePath, "backend", "node_modules", "leftpad"), { recursive: true });
    await mkdir(join(prepared.worktreePath, "frontend", "dist"), { recursive: true });
    await writeFile(join(prepared.worktreePath, "backend", "node_modules", "leftpad", "index.js"), "module.exports = 1;\n", "utf8");
    await writeFile(join(prepared.worktreePath, "frontend", "dist", "index.html"), "<div>built</div>\n", "utf8");
    await writeFile(join(prepared.worktreePath, "backend", "src.ts"), "export const ok = true;\n", "utf8");
    const preview = await service.getDiffPreview(prepared);
    const result = await service.complete(prepared, "# Summary\n");

    expect(preview.changedFiles).toContain("backend/src.ts");
    expect(preview.changedFiles.some((file) => file.includes("node_modules") || file.includes("dist"))).toBe(false);
    expect(result.status).toBe("synced");
    await expect(readFile(join(repoPath, "backend", "src.ts"), "utf8")).resolves.toContain("ok");
    await expect(access(join(repoPath, "backend", "node_modules"))).rejects.toThrow();
    await expect(access(join(repoPath, "frontend", "dist"))).rejects.toThrow();
  });

  it("removes legacy target repo .agenthub worktrees on complete without touching other .agenthub content", async () => {
    repoPath = await mkdtemp(join(tmpdir(), "agenthub-legacy-worktrees-"));
    await initRepo(repoPath);
    await mkdir(join(repoPath, ".agenthub", "worktrees", "legacy-empty"), { recursive: true });
    await mkdir(join(repoPath, ".agenthub", "kept"), { recursive: true });
    await writeFile(join(repoPath, ".agenthub", "kept", "note.txt"), "keep\n", "utf8");

    const service = new WorktreeService();
    const prepared = await service.prepare("run-904", repoPath);
    await expect(access(join(repoPath, ".agenthub", "worktrees"))).rejects.toThrow();

    await mkdir(join(repoPath, ".agenthub", "worktrees", "legacy-after-prepare"), { recursive: true });
    await writeFile(join(repoPath, ".agenthub", "worktrees", "legacy-after-prepare", "old.txt"), "old\n", "utf8");
    await writeFile(join(prepared.worktreePath, "generated.txt"), "hello\n", "utf8");
    const result = await service.complete(prepared, "# Summary\n");

    expect(result.status).toBe("synced");
    await expect(access(join(repoPath, ".agenthub", "worktrees"))).rejects.toThrow();
    await expect(readFile(join(repoPath, ".agenthub", "kept", "note.txt"), "utf8")).resolves.toBe("keep\n");
  });

  it("syncs MOCK_AGENT generated backend and frontend files back to main", async () => {
    repoPath = await mkdtemp(join(tmpdir(), "agenthub-mock-"));
    await initRepo(repoPath);

    const previousMockAgent = process.env.MOCK_AGENT;
    process.env.MOCK_AGENT = "true";
    try {
      const worktrees = new WorktreeService();
      const runner = new AgentRunner();
      const prepared = await worktrees.prepare("run-901", repoPath);
      const run: AgentRun = {
        id: "run-901",
        agentId: "claude",
        conversationId: "session-current",
        status: "running",
        runtime: {
          agentId: "claude",
          displayName: "Claude",
          provider: "anthropic",
          role: "coding-agent",
          worktreePath: prepared.worktreePath,
          branchName: prepared.branchName,
          status: "running"
        },
        prompt: "generate mock todo files",
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString()
      };

      const result = await runner.run({
        run,
        prompt: run.prompt,
        worktree: prepared,
        emit: vi.fn((_event: Omit<AgentEvent, "eventId" | "seq" | "ts">) => undefined)
      });
      const sync = await worktrees.complete(prepared, result.summary);

      expect(sync.status).toBe("synced");
      const backendFile = await readFile(join(repoPath, "backend", "src", "generated", "todo-service.ts"), "utf8");
      const frontendFile = await readFile(join(repoPath, "frontend", "src", "generated", "TodoList.tsx"), "utf8");
      expect(backendFile).toContain("export interface TodoItem");
      expect(frontendFile).toContain("export function TodoList");
      await expect(access(prepared.worktreePath)).rejects.toThrow();
    } finally {
      if (previousMockAgent === undefined) {
        delete process.env.MOCK_AGENT;
      } else {
        process.env.MOCK_AGENT = previousMockAgent;
      }
    }
  });

  it("removes the exact stale run worktree path before reusing a run id", async () => {
    repoPath = await mkdtemp(join(tmpdir(), "agenthub-stale-"));
    await initRepo(repoPath);

    const stalePath = join(repoPath, ".agenthub", "worktrees", "run-902-main");
    await mkdir(stalePath, { recursive: true });
    await writeFile(join(stalePath, "stale.txt"), "old\n", "utf8");

    const service = new WorktreeService();
    const prepared = await service.prepare("run-902", repoPath);

    await expect(readFile(join(prepared.worktreePath, "README.md"), "utf8")).resolves.toContain("# Test");
    await expect(readFile(join(prepared.worktreePath, "stale.txt"), "utf8")).rejects.toThrow();
  });
});

async function initRepo(repoPath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: repoPath });
  await writeFile(join(repoPath, "README.md"), "# Test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });
}
