import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    } finally {
      if (previousMockAgent === undefined) {
        delete process.env.MOCK_AGENT;
      } else {
        process.env.MOCK_AGENT = previousMockAgent;
      }
    }
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
