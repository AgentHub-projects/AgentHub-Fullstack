import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKSPACE_PATH, type AgentEvent, type CodeDiffPreview } from "@agenthub/shared";
import { AgentRunner } from "../src/services/agent-runner.service";
import { AgentService } from "../src/services/agent.service";
import { ConversationService } from "../src/services/conversation.service";
import { OrchestrationService } from "../src/services/orchestration.service";
import { TeamService } from "../src/services/team.service";
import { WorktreeService, type PreparedWorktree } from "../src/services/worktree.service";

describe("Conversation workspace binding", () => {
  it("defaults new conversations to the AgentHub test workspace", () => {
    const service = new ConversationService();
    const conversation = service.create({ title: "Full-Stack Team", type: "team" });

    expect(conversation.workspacePath).toBe(DEFAULT_WORKSPACE_PATH);
    expect(conversation.isPinned).toBe(false);
    expect(conversation.isArchived).toBe(false);
    expect(conversation.pinnedMessageIds).toEqual([]);
  });

  it("updates conversation pin/archive state and sorts pinned conversations first", () => {
    const service = new ConversationService();
    const first = service.create({ title: "First", type: "team" });
    const second = service.create({ title: "Second", type: "team" });

    const updated = service.update(first.id, { isPinned: true, isArchived: true });

    expect(updated.isPinned).toBe(true);
    expect(updated.isArchived).toBe(true);
    expect(updated.pinnedAt).toBeTruthy();
    expect(updated.archivedAt).toBeTruthy();
    expect(service.list().items[0]?.id).toBe(first.id);
    expect(service.list().items.map((item) => item.id)).toContain(second.id);
  });

  it("pins and unpins messages in a conversation", () => {
    const service = new ConversationService();
    const conversation = service.create({ title: "Pin Test", type: "team" });
    const message = service.createMessage(conversation.id, { content: "Important context" });

    const pinned = service.pinMessage(conversation.id, message.id, { pinned: true });
    expect(pinned.pinned).toBe(true);
    expect(service.get(conversation.id).pinnedMessageIds).toEqual([message.id]);

    const unpinned = service.pinMessage(conversation.id, message.id, { pinned: false });
    expect(unpinned.pinned).toBe(false);
    expect(service.get(conversation.id).pinnedMessageIds).toEqual([]);
  });

  it("uses the conversation workspace when starting a team run", async () => {
    const workspacePath = "D:\\agent\\AgentHub-Custom";
    const conversations = new ConversationService();
    const agents = new AgentService();
    const teams = new TeamService();
    const conversation = conversations.create({
      title: "Custom Workspace",
      type: "team",
      teamId: "team-default",
      agentId: "orchestrator",
      workspacePath,
    });

    const runner = {
      run: vi.fn(async ({ run }: { run: { id: string; agentId: string } }) => {
        if (run.id.endsWith("-plan")) {
          return {
            output: [
              "---AGENTHUB_PLAN---",
              JSON.stringify({
                summary: "Build full stack app",
                tasks: [
                  { agentId: "backend-agent", task: "Build API", dependsOn: [] },
                  { agentId: "frontend-agent", task: "Build UI", dependsOn: ["backend-agent"] },
                ],
              }),
              "---END_AGENTHUB_PLAN---",
            ].join("\n"),
            summary: "planned",
          };
        }
        if (run.id.includes("-verify-")) {
          return {
            output: [
              "---AGENTHUB_VERDICT---",
              JSON.stringify({ verdict: "complete", summary: "done" }),
              "---END_AGENTHUB_VERDICT---",
            ].join("\n"),
            summary: "verified",
          };
        }
        return { output: `${run.agentId} done`, summary: `${run.agentId} done` };
      }),
    } as unknown as AgentRunner;

    const worktrees = {
      prepare: vi.fn(async (runId: string, repoPath?: string): Promise<PreparedWorktree> => ({
        repoPath: repoPath ?? "",
        branchName: `agent/${runId}/main`,
        worktreePath: `${repoPath}\\${runId}`,
        summaryPath: `${repoPath}\\summary.md`,
        logPath: `${repoPath}\\agent.log`,
      })),
      getDiffPreview: vi.fn(async (prepared: PreparedWorktree): Promise<CodeDiffPreview> => ({
        worktreePath: prepared.worktreePath,
        branchName: prepared.branchName,
        changedFiles: [],
        stat: "",
        patch: "",
        truncated: false,
      })),
      complete: vi.fn(async () => ({
        status: "synced",
        targetBranch: "main",
        commitSha: "abc123",
      })),
    } as unknown as WorktreeService;
    const gateway = {
      emitAgentEvent: vi.fn((_event: AgentEvent) => undefined),
    };
    const orchestration = new OrchestrationService(
      runner,
      worktrees,
      agents,
      teams,
      conversations,
      gateway as never,
    );

    const run = await orchestration.startTeamRun("team-default", {
      prompt: "build todo",
      conversationId: conversation.id,
      repositoryPath: "D:\\agent\\Ignored",
    });

    await waitFor(() => run.status === "succeeded");
    expect((worktrees.prepare as unknown as ReturnType<typeof vi.fn>).mock.calls).toSatisfy(
      (calls: unknown[][]) => calls.length > 0 && calls.every((call) => call[1] === workspacePath),
    );
  });

  it("fails the team run when a dependency task fails instead of hanging", async () => {
    const conversations = new ConversationService();
    const agents = new AgentService();
    const teams = new TeamService();
    const conversation = conversations.create({
      title: "Dependency Failure",
      type: "team",
      teamId: "team-default",
      agentId: "orchestrator",
    });

    const runner = {
      run: vi.fn(async ({ run }: { run: { id: string; agentId: string } }) => {
        if (run.id.endsWith("-plan")) {
          return {
            output: [
              "---AGENTHUB_PLAN---",
              JSON.stringify({
                summary: "Build full stack app",
                tasks: [
                  { agentId: "backend-agent", task: "Build API", dependsOn: [] },
                  { agentId: "frontend-agent", task: "Build UI", dependsOn: ["backend-agent"] },
                ],
              }),
              "---END_AGENTHUB_PLAN---",
            ].join("\n"),
            summary: "planned",
          };
        }
        throw new Error(`${run.agentId} failed`);
      }),
    } as unknown as AgentRunner;

    const worktrees = {
      prepare: vi.fn(async (runId: string, repoPath?: string): Promise<PreparedWorktree> => ({
        repoPath: repoPath ?? "",
        branchName: `agent/${runId}/main`,
        worktreePath: `${repoPath ?? DEFAULT_WORKSPACE_PATH}\\${runId}`,
        summaryPath: `${repoPath ?? DEFAULT_WORKSPACE_PATH}\\summary.md`,
        logPath: `${repoPath ?? DEFAULT_WORKSPACE_PATH}\\agent.log`,
      })),
      getDiffPreview: vi.fn(),
      complete: vi.fn(),
    } as unknown as WorktreeService;
    const gateway = {
      emitAgentEvent: vi.fn((_event: AgentEvent) => undefined),
    };
    const orchestration = new OrchestrationService(
      runner,
      worktrees,
      agents,
      teams,
      conversations,
      gateway as never,
    );

    const run = await orchestration.startTeamRun("team-default", {
      prompt: "build todo",
      conversationId: conversation.id,
    });

    await waitFor(() => run.status === "failed");
    expect(run.taskResults.map((result) => `${result.agentId}:${result.status}`)).toEqual([
      "backend-agent:failed",
      "frontend-agent:failed",
    ]);
    expect(run.taskResults[1]?.output).toContain("依赖任务失败");
    expect(conversations.listMessages(conversation.id).items.at(-1)?.role).toBe("assistant");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for predicate");
}
