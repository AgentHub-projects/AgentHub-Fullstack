import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun } from "@agenthub/shared";
import {
  AgentRunner,
  buildAgentCommandEnv,
  parseClaudeStreamLine
} from "../src/services/agent-runner.service";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

describe("parseClaudeStreamLine", () => {
  it("extracts text from Claude stream-json shapes as ParsedClaudeEvent", () => {
    const result1 = parseClaudeStreamLine(JSON.stringify({ text: "hello" }));
    expect(result1?.text).toBe("hello");
    expect(result1?.agentEventType).toBeTruthy();

    const result2 = parseClaudeStreamLine(JSON.stringify({ delta: { text: " world" } }));
    expect(result2?.text).toBe(" world");

    const result3 = parseClaudeStreamLine(JSON.stringify({ content: [{ type: "text", text: "!" }] }));
    expect(result3?.text).toBe("!");
  });

  it("handles non-json and empty input", () => {
    const result1 = parseClaudeStreamLine("raw text");
    expect(result1?.text).toBe("raw text");
    expect(result1?.agentEventType).toBeTruthy();

    expect(parseClaudeStreamLine("")).toBeUndefined();
  });
});

describe("buildAgentCommandEnv", () => {
  it("keeps only local CLI environment entries", () => {
    const env = buildAgentCommandEnv({
      PATH: "C:\\bin",
      CLAUDE_CONFIG_DIR: "C:\\claude",
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_AUTH_TOKEN: "secret",
      OPENAI_API_KEY: "secret"
    });

    expect(env.PATH).toBe("C:\\bin");
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:\\claude");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
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
            cwd: tempDir,
            shell: true
          }
        })
      );
      expect(spawnMock).toHaveBeenCalledWith(
        "claude-test",
        ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
        expect.objectContaining({ cwd: tempDir, shell: true })
      );
      expect(child.stdin.end).toHaveBeenCalledWith(expect.stringContaining("用户原始需求：\nimplement this"));

      child.stdout.emit("data", Buffer.from(`${JSON.stringify({ text: "hello" })}\n`, "utf8"));
      child.emit("close", 0);

      await expect(resultPromise).resolves.toMatchObject({ output: "hello" });
      await expect(readFile(join(tempDir, "agent.log"), "utf8")).resolves.toContain(
        '"mode":"claude-cli","command":"claude-test","cwd"'
      );
      await expect(readFile(join(tempDir, "agent.log"), "utf8")).resolves.toContain('"shell":true');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the default claude command through a shell for local shims", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenthub-runner-"));
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);

    try {
      const runner = new AgentRunner();
      const resultPromise = runner.run(createContext(tempDir, vi.fn()));

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      expect(spawnMock).toHaveBeenCalledWith(
        "claude",
        ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
        expect.objectContaining({
          cwd: tempDir,
          env: expect.any(Object),
          shell: true
        })
      );
      expect(spawnMock.mock.calls[0]?.[2]?.env).not.toBe(process.env);
      expect(child.stdin.end).toHaveBeenCalledWith(expect.stringContaining("用户原始需求：\nimplement this"));

      child.stdout.emit("data", Buffer.from("done\n", "utf8"));
      child.emit("close", 0);

      await expect(resultPromise).resolves.toMatchObject({ output: "done" });
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

describe("AgentRunner mock path", () => {
  afterEach(() => {
    delete process.env.MOCK_AGENT;
  });

  it("marks events and output as mock when MOCK_AGENT is enabled", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenthub-runner-mock-"));
    process.env.MOCK_AGENT = "true";

    try {
      const emit = vi.fn();
      const runner = new AgentRunner();
      const result = await runner.run(createContext(tempDir, emit));

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent_thinking",
          payload: { mode: "mock", mock: true }
        })
      );
      expect(result.output).toContain("MOCK_AGENT=true mock run");
      expect(result.output).toContain("Wrapped prompt:");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not pass provider API environment variables to Claude", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agenthub-runner-"));
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    const previousEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR
    };
    process.env.ANTHROPIC_API_KEY = "anthropic-secret";
    process.env.ANTHROPIC_AUTH_TOKEN = "anthropic-token";
    process.env.OPENAI_API_KEY = "openai-secret";
    process.env.CLAUDE_CONFIG_DIR = "C:\\claude-config";

    try {
      const runner = new AgentRunner();
      const resultPromise = runner.run(createContext(tempDir, vi.fn()));

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
      const spawnOptions = spawnMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      expect(spawnOptions.env).toMatchObject({ CLAUDE_CONFIG_DIR: "C:\\claude-config" });
      expect(spawnOptions.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(spawnOptions.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(spawnOptions.env?.OPENAI_API_KEY).toBeUndefined();
      expect(Object.keys(spawnOptions.env ?? {}).filter((key) => /^ANTHROPIC_|^OPENAI_/.test(key))).toEqual([]);

      child.stdout.emit("data", Buffer.from("done\n", "utf8"));
      child.emit("close", 0);

      await expect(resultPromise).resolves.toMatchObject({ output: "done" });
    } finally {
      restoreEnv(previousEnv);
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

function restoreEnv(previousEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
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
