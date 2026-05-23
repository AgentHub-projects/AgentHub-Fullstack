import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@agenthub/shared";
import { AgentRunner, parseClaudeStreamLine } from "../src/services/agent-runner.service";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

describe("parseClaudeStreamLine", () => {
  it("extracts plain text from Claude stream-json shapes", () => {
    expect(parseClaudeStreamLine(JSON.stringify({ text: "hello" }))).toBe("hello");
    expect(parseClaudeStreamLine(JSON.stringify({ delta: { text: " world" } }))).toBe(" world");
    expect(parseClaudeStreamLine(JSON.stringify({ content: [{ type: "text", text: "!" }] }))).toBe("!");
  });

  it("keeps non-json output as text", () => {
    expect(parseClaudeStreamLine("raw text")).toBe("raw text");
    expect(parseClaudeStreamLine("")).toBeUndefined();
  });
});

describe("AgentRunner claude cli path", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_COMMAND;
    delete process.env.MOCK_AGENT;
  });

  it("emits and logs local Claude CLI evidence before streaming output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenthub-runner-"));
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    process.env.AGENT_COMMAND = "claude-test";

    try {
      const emit = vi.fn();
      const runner = new AgentRunner();
      const resultPromise = runner.run(createContext(tempDir, emit));

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent_thinking",
          payload: {
            mode: "claude-cli",
            command: "claude-test",
            cwd: tempDir
          }
        })
      );
      expect(spawnMock).toHaveBeenCalledWith(
        "claude-test",
        ["--print", "--output-format", "stream-json", "--dangerously-skip-permissions"],
        expect.objectContaining({ cwd: tempDir })
      );

      child.stdout.emit("data", Buffer.from(`${JSON.stringify({ text: "hello" })}\n`, "utf8"));
      child.emit("close", 0);

      await expect(resultPromise).resolves.toMatchObject({ output: "hello" });
      await expect(readFile(join(tempDir, "agent.log"), "utf8")).resolves.toContain(
        '"mode":"claude-cli","command":"claude-test","cwd"'
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps CLI evidence and stderr when Claude exits nonzero", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenthub-runner-"));
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);

    try {
      const runner = new AgentRunner();
      const resultPromise = runner.run(createContext(tempDir, vi.fn()));

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      child.stderr.emit("data", Buffer.from("auth failed", "utf8"));
      child.emit("close", 2);

      await expect(resultPromise).rejects.toThrow("auth failed");
      expect(runner.cancel("run-001")).toBe(false);
      const log = await readFile(join(tempDir, "agent.log"), "utf8");
      expect(log).toContain('"mode":"claude-cli"');
      expect(log).toContain("auth failed");
      expect(log).toContain("Failure: auth failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes failed children and writes spawn errors to the run log", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenthub-runner-"));
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);

    try {
      const runner = new AgentRunner();
      const resultPromise = runner.run(createContext(tempDir, vi.fn()));

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      child.emit("error", new Error("ENOENT"));

      await expect(resultPromise).rejects.toThrow('Failed to spawn agent command "claude": ENOENT');
      expect(runner.cancel("run-001")).toBe(false);
      const log = await readFile(join(tempDir, "agent.log"), "utf8");
      expect(log).toContain('"mode":"claude-cli"');
      expect(log).toContain("Spawn failed: ENOENT");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createMockChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      end: vi.fn()
    },
    kill: vi.fn()
  });
}

function createContext(worktreePath: string, emit: ReturnType<typeof vi.fn>) {
  const run = {
    id: "run-001",
    agentId: "agent-001",
    conversationId: "conversation-001"
  } as AgentRun;

  return {
    run,
    prompt: "implement this",
    worktree: {
      repoPath: worktreePath,
      branchName: "agent/run-001/main",
      worktreePath,
      summaryPath: join(worktreePath, "summary.md"),
      logPath: join(worktreePath, "agent.log")
    },
    emit
  };
}
